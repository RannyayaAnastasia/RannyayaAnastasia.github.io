from base64 import urlsafe_b64encode
from hashlib import sha256
from json import load
from secrets import token_urlsafe
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

VK_ORIGIN = "https://id.vk.ru"
YANDEX_ORIGIN = "https://oauth.yandex.ru"
PROVIDERS = ("vk", "yandex")


def random_token():
    return token_urlsafe(32)


def digest(value):
    return urlsafe_b64encode(sha256(value.encode()).digest()).decode().rstrip("=")


def callback(config, provider):
    return f"{config['APP_ORIGIN']}/auth/{provider}/callback"


def authorization_url(config, provider, state, verifier):
    is_vk = provider == "vk"
    query = {
        "client_id": config["VK_CLIENT_ID" if is_vk else "YANDEX_CLIENT_ID"],
        "redirect_uri": callback(config, provider),
        "response_type": "code",
        "state": state,
        "code_challenge": digest(verifier),
        "code_challenge_method": "s256" if is_vk else "S256",
    }
    query.update({"scope": "", "prompt": "login"} if is_vk else {"scope": "login:info"})
    return (VK_ORIGIN if is_vk else YANDEX_ORIGIN) + "/authorize?" + urlencode(query)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get_json(url, *, form=None, headers=None):
    data = urlencode(form).encode() if form is not None else None
    request = Request(url, data=data, headers=headers or {})
    with build_opener(NoRedirect()).open(request, timeout=10) as response:
        result = load(response)
    if not isinstance(result, dict) or result.get("error"):
        raise ValueError("OAuth provider rejected the request")
    return result


def provider_profile(config, provider, args, attempt):
    code = args.get("code")
    if not code:
        raise ValueError("Missing authorization code")

    exchange = {
        "grant_type": "authorization_code",
        "code_verifier": attempt["verifier"],
    }
    if provider == "vk":
        device = args.get("device_id")
        if not device:
            raise ValueError("Missing VK device ID")
        client_id = config["VK_CLIENT_ID"]
        query = urlencode({
            **exchange,
            "client_id": client_id,
            "redirect_uri": callback(config, provider),
            "state": attempt["state"],
            "device_id": device,
        })
        token = get_json(f"{VK_ORIGIN}/oauth2/auth?{query}", form={"code": code})
        if token.get("state") != attempt["state"] or not token.get("access_token"):
            raise ValueError("Invalid VK token response")
        profile = get_json(
            f"{VK_ORIGIN}/oauth2/user_info?{urlencode({'client_id': client_id})}",
            form={"access_token": token["access_token"]},
        ).get("user") or {}
        subject = profile.get("user_id")
    else:
        exchange.update({"client_id": config["YANDEX_CLIENT_ID"], "code": code})
        if config["YANDEX_CLIENT_SECRET"]:
            exchange["client_secret"] = config["YANDEX_CLIENT_SECRET"]
        token = get_json(f"{YANDEX_ORIGIN}/token", form=exchange)
        if not token.get("access_token"):
            raise ValueError("Invalid Yandex token response")
        profile = get_json(
            "https://login.yandex.ru/info?format=json",
            headers={"Authorization": "OAuth " + token["access_token"]},
        )
        subject = profile.get("id")
    subject = str(subject)
    if not subject.isascii() or not subject.isdecimal():
        raise ValueError("Invalid OAuth subject")
    return subject, (profile.get("first_name") or "").strip()[:60] or "Участник клуба"
