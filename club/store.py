import sqlite3
from pathlib import Path

from flask import current_app, g


def init_store(app):
    with app.app_context():
        schema = Path(__file__).with_name("schema.sql").read_text(encoding="utf-8")
        connection = database()
        if app.config["DATABASE_URL"]:
            connection.execute(schema)
        else:
            connection.executescript(schema)


def database():
    if "db" not in g:
        url = current_app.config["DATABASE_URL"]
        if url:
            import psycopg
            from psycopg.rows import dict_row

            g.db = psycopg.connect(url, row_factory=dict_row, autocommit=True, connect_timeout=10)
        else:
            connection = sqlite3.connect(current_app.config["LOCAL_DB"], isolation_level=None)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys = ON")
            g.db = connection
    return g.db


def execute(sql, *values):
    if not current_app.config["DATABASE_URL"]:
        sql = sql.replace("%s", "?")
    return database().execute(sql, values)


def close_store(_error=None):
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()
