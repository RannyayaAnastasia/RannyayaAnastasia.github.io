import os
import re
from datetime import date, timedelta
from functools import wraps
from pathlib import Path
from secrets import compare_digest
from time import time
from urllib.parse import urlsplit
from uuid import uuid4

from flask import Flask, abort, current_app, g, redirect, render_template, request, send_from_directory, url_for
from werkzeug.exceptions import HTTPException

from calendar_weeks import date_label, monday_of, today_in_moscow, workout_summary
from oauth import PROVIDERS, authorization_url, digest, provider_profile, random_token
from store import close_store, execute, init_store

PORTFOLIO = "https://rannyayaanastasia.github.io/"
LOGIN_AGE = 10 * 60
SESSION_AGE = 14 * 86400
TOKEN_PATTERN = re.compile(r"[A-Za-z0-9_-]{43}")
SECTIONS = {"training": "Тренировки", "books": "Книги", "music": "Музыка"}


def create_app(overrides=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        APP_ORIGIN=os.getenv("APP_ORIGIN") or os.getenv("RENDER_EXTERNAL_URL") or "http://localhost:8001",
        DATABASE_URL=os.getenv("DATABASE_URL"),
        LOCAL_DB=os.getenv("LOCAL_DB") or str(Path.home() / ".rannyaya-club.sqlite"),
        VK_CLIENT_ID=os.getenv("VK_CLIENT_ID"),
        YANDEX_CLIENT_ID=os.getenv("YANDEX_CLIENT_ID"),
        YANDEX_CLIENT_SECRET=os.getenv("YANDEX_CLIENT_SECRET"),
        OWNER_MEMBER_ID=os.getenv("OWNER_MEMBER_ID"),
        MAX_CONTENT_LENGTH=16000,
    )
    if overrides:
        app.config.update(overrides)
    address = urlsplit(app.config["APP_ORIGIN"])
    app.config["APP_ORIGIN"] = f"{address.scheme}://{address.netloc}"
    app.config["SECURE_COOKIES"] = address.scheme == "https"
    if os.getenv("RENDER") and not app.config["DATABASE_URL"]:
        raise RuntimeError("Set DATABASE_URL for the Render service")
    if app.config["DATABASE_URL"] and not app.config["SECURE_COOKIES"]:
        raise RuntimeError("Set an HTTPS APP_ORIGIN for the deployed club")
    app.teardown_appcontext(close_store)
    init_store(app)
    app.jinja_env.globals.update(portfolio=PORTFOLIO, sections=SECTIONS, date_label=date_label)

    @app.after_request
    def response_headers(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'none'; style-src 'self'; form-action 'self'; "
            "base-uri 'none'; frame-ancestors 'none'"
        )
        return response

    @app.errorhandler(HTTPException)
    def show_error(error):
        message = error.description if error.code < 500 else "Произошла ошибка. Попробуй чуть позже."
        return render_template("error.html", title="Ошибка", message=message), error.code

    @app.get("/health")
    def health():
        execute("SELECT 1").fetchone()
        return "ok", 200, {"Content-Type": "text/plain; charset=utf-8"}

    @app.get("/club.css")
    def stylesheet():
        return send_from_directory(app.root_path, "club.css")

    @app.get("/")
    def home():
        if load_member():
            return redirect(url_for("training"), 303)
        return login_page()

    @app.get("/auth/<provider>")
    def start_login(provider):
        client_id = provider_id(provider)
        if not client_id:
            return login_page(), 503
        state, browser, verifier = (random_token() for _ in range(3))
        timestamp = int(time())
        execute("DELETE FROM oauth_attempts WHERE expires <= %s", timestamp)
        execute(
            "INSERT INTO oauth_attempts VALUES (%s, %s, %s, %s, %s)",
            state, digest(browser), provider, verifier, timestamp + LOGIN_AGE,
        )
        response = redirect(authorization_url(app.config, provider, state, verifier), 302)
        return set_cookie(response, "oauth-" + provider, browser, LOGIN_AGE)

    @app.get("/auth/<provider>/callback")
    def finish_login(provider):
        if not provider_id(provider):
            return login_page(), 503
        error_response = redirect(url_for("home", login="error"), 303)
        browser = read_cookie("oauth-" + provider)
        state = request.args.get("state", "")
        if not browser or not TOKEN_PATTERN.fullmatch(state):
            return error_response
        attempt = execute(
            """DELETE FROM oauth_attempts
               WHERE state = %s AND browser_hash = %s AND provider = %s AND expires > %s
               RETURNING state, verifier""",
            state, digest(browser), provider, int(time()),
        ).fetchone()
        if not attempt:
            return error_response
        set_cookie(error_response, "oauth-" + provider, "", 0)
        if "error" in request.args:
            return error_response

        try:
            subject, name = provider_profile(app.config, provider, request.args, attempt)
        except (OSError, ValueError, AttributeError) as error:
            app.logger.warning("OAuth exchange failed for %s (%s)", provider, type(error).__name__)
            return error_response

        execute(
            """INSERT INTO members (id, provider, subject, name) VALUES (%s, %s, %s, %s)
               ON CONFLICT (provider, subject) DO NOTHING""",
            str(uuid4()), provider, subject, name,
        )
        member = execute(
            "SELECT id FROM members WHERE provider = %s AND subject = %s", provider, subject,
        ).fetchone()
        token = random_token()
        timestamp = int(time())
        execute(
            "INSERT INTO sessions (token_hash, member_id, expires) VALUES (%s, %s, %s)",
            digest(token), member["id"], timestamp + SESSION_AGE,
        )
        execute(
            "DELETE FROM sessions WHERE expires <= %s OR token_hash = %s",
            timestamp, digest(read_cookie("session") or ""),
        )
        response = redirect(url_for("training"), 303)
        set_cookie(response, "oauth-" + provider, "", 0)
        return set_cookie(response, "session", token, SESSION_AGE)

    @app.post("/logout")
    @members_only
    def logout():
        execute("DELETE FROM sessions WHERE token_hash = %s", digest(g.session_token))
        return set_cookie(redirect(url_for("home"), 303), "session", "", 0)

    @app.route("/profile", methods=["GET", "POST"])
    @members_only
    def profile():
        if request.method == "POST":
            name = field("name", 60, required=True)
            execute("UPDATE members SET name = %s WHERE id = %s", name, g.member["id"])
            return redirect(url_for("profile"), 303)
        return render_template("profile.html", title="Профиль")

    @app.route("/training", methods=["GET", "POST"])
    @members_only
    def training():
        today = today_in_moscow()
        monday = monday_of(today)
        if request.method == "POST":
            update_workout(monday, today)
            return redirect(url_for("training"), 303)

        members = execute("SELECT id, name FROM members ORDER BY name, id").fetchall()
        days_by_member = {member["id"]: [] for member in members}
        for workout in execute("SELECT member_id, day FROM workouts WHERE day <= %s", today.isoformat()):
            if workout["member_id"] in days_by_member:
                days_by_member[workout["member_id"]].append(workout["day"])
        board = []
        for member in members:
            count, streak = workout_summary(days_by_member[member["id"]], monday)
            board.append({**dict(member), "count": count, "streak": streak})
        my_days = days_by_member.get(g.member["id"], [])
        weekdays = ("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс")
        days = []
        for offset, name in enumerate(weekdays):
            day = monday + timedelta(days=offset)
            days.append({
                "name": name, "date": day, "value": day.isoformat(),
                "marked": day.isoformat() in my_days, "future": day > today,
            })
        return render_template(
            "training.html", title=SECTIONS["training"], current="training", board=board, days=days,
            active=sum(row["count"] > 0 for row in board),
        )

    @app.route("/books", defaults={"kind": "books"}, methods=["GET", "POST"])
    @app.route("/music", defaults={"kind": "music"}, methods=["GET", "POST"])
    @members_only
    def recommendations(kind):
        if request.method == "POST":
            execute(
                """INSERT INTO recommendations (id, member_id, kind, title, creator, note, link, created)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                str(uuid4()), g.member["id"], kind, *recommendation_fields(kind), int(time() * 1000),
            )
            return redirect(url_for("recommendations", kind=kind), 303)
        number = min(100000, max(1, request.args.get("page", 1, type=int)))
        items = execute(
            """SELECT r.*, m.name FROM recommendations r JOIN members m ON m.id = r.member_id
               WHERE r.kind = %s ORDER BY r.created DESC, r.id LIMIT 21 OFFSET %s""",
            kind, (number - 1) * 20,
        ).fetchall()
        return render_template(
            "recommendations.html", title=SECTIONS[kind], current=kind, kind=kind,
            items=[dict(item) for item in items[:20]], number=number, has_more=len(items) > 20,
            reactions={"": "Без отметки", "later": "Хочу познакомиться",
                       "done": "Прочитала" if kind == "books" else "Послушала"},
        )

    @app.post("/<kind>/<uuid:item_id>/<action>")
    @members_only
    def change_recommendation(kind, item_id, action):
        if kind not in ("books", "music") or action not in ("edit", "delete", "reply"):
            abort(404, "Рекомендация не найдена.")
        item_id = str(item_id)
        item = execute(
            "SELECT member_id FROM recommendations WHERE id = %s AND kind = %s", item_id, kind,
        ).fetchone()
        if not item:
            abort(404, "Рекомендация не найдена.")
        if action == "reply":
            if not g.member["owner"]:
                abort(403, "Ответить может Анастасия.")
            reaction = field("reaction", 5)
            if reaction not in ("", "later", "done"):
                abort(400, "Выбери отметку из списка.")
            execute(
                "UPDATE recommendations SET reaction = %s, reply = %s WHERE id = %s",
                reaction, field("reply", 600), item_id,
            )
        elif item["member_id"] != g.member["id"]:
            abort(403, "Менять запись может её автор.")
        elif action == "edit":
            execute(
                "UPDATE recommendations SET title = %s, creator = %s, note = %s, link = %s WHERE id = %s",
                *recommendation_fields(kind), item_id,
            )
        else:
            execute("DELETE FROM recommendations WHERE id = %s", item_id)
        return redirect(url_for("recommendations", kind=kind), 303)

    return app


def provider_id(provider):
    if provider not in PROVIDERS:
        abort(404)
    return current_app.config[provider.upper() + "_CLIENT_ID"]


def login_page():
    return render_template(
        "login.html", title="Вход", error=request.args.get("login") == "error",
        providers={provider: provider_id(provider) for provider in PROVIDERS},
    )


def cookie_name(key):
    prefix = "__Host-" if current_app.config["SECURE_COOKIES"] else ""
    return prefix + "club-" + key


def read_cookie(key):
    value = request.cookies.get(cookie_name(key), "")
    return value if TOKEN_PATTERN.fullmatch(value) else None


def set_cookie(response, key, value, age):
    response.set_cookie(
        cookie_name(key), value, max_age=age,
        secure=current_app.config["SECURE_COOKIES"], httponly=True, samesite="Lax",
    )
    return response


def load_member():
    token = read_cookie("session")
    if not token:
        return None
    member = execute(
        """SELECT m.id, m.name, m.provider
           FROM sessions s JOIN members m ON m.id = s.member_id
           WHERE s.token_hash = %s AND s.expires > %s""",
        digest(token), int(time()),
    ).fetchone()
    if member:
        g.session_token = token
        g.member = {
            **dict(member),
            "csrf": digest("form:" + token),
            "owner": member["id"] == current_app.config["OWNER_MEMBER_ID"],
        }
        return g.member
    return None


def members_only(view):
    @wraps(view)
    def authorized(*args, **kwargs):
        member = load_member()
        if not member:
            if request.method == "POST":
                abort(401, "Войди в клуб, чтобы продолжить.")
            return redirect(url_for("home"), 303)
        if request.method == "POST":
            origin = request.headers.get("Origin")
            if origin and origin != current_app.config["APP_ORIGIN"]:
                abort(403, "Открой форму на странице клуба.")
            csrf = request.form.get("csrf", "")
            if not TOKEN_PATTERN.fullmatch(csrf) or not compare_digest(csrf, member["csrf"]):
                abort(403, "Открой форму и попробуй ещё раз.")
        return view(*args, **kwargs)
    return authorized


def field(name, limit, required=False):
    value = request.form.get(name, "").strip()
    if (required and not value) or len(value) > limit or "\x00" in value:
        abort(400, "Проверь, что обязательные поля заполнены, а текст помещается в форму.")
    return value


def recommendation_fields(kind):
    title = field("title", 120, required=True)
    creator = field("creator", 120, required=True)
    note = field("note", 600)
    link = field("link", 500) if kind == "music" else ""
    if link:
        try:
            address = urlsplit(link)
            valid = (address.scheme in ("https", "http") and address.hostname
                     and address.username is None and address.password is None)
        except ValueError:
            valid = False
        if not valid or any(char.isspace() or ord(char) < 32 for char in link):
            abort(400, "Укажи ссылку, которая начинается с https:// или http://.")
    return title, creator, note, link


def update_workout(monday, today):
    raw_day = request.form.get("day", "")
    action = request.form.get("action")
    try:
        day = date.fromisoformat(raw_day)
    except ValueError:
        day = None
    if not day or raw_day != day.isoformat() or not monday <= day <= today or action not in ("add", "remove"):
        abort(400, "Выбери прошедший или текущий день этой недели.")
    if action == "add":
        execute(
            "INSERT INTO workouts (member_id, day) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            g.member["id"], raw_day,
        )
    else:
        execute("DELETE FROM workouts WHERE member_id = %s AND day = %s", g.member["id"], raw_day)


app = create_app()
