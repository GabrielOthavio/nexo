from pathlib import Path
import os
from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = os.environ.get('SECRET_KEY')
if not SECRET_KEY:
    raise ValueError("A variável de ambiente SECRET_KEY não está definida.")

DEBUG = os.environ.get('DEBUG', 'False').lower() == 'true'

ALLOWED_HOSTS = [h.strip() for h in os.environ.get('ALLOWED_HOSTS', '127.0.0.1,localhost').split(',')]

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'Auth.apps.AuthConfig',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    # Antes de qualquer coisa que toque no banco: byte nulo em parâmetro
    # derruba o psycopg2 com 500 (ver Auth/middleware.py).
    'Auth.middleware.RejeitaByteNuloMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'Auth.middleware.CurrentUserMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'config.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'config.wsgi.application'

# DB_ENGINE=sqlite permite rodar localmente sem um servidor PostgreSQL
# (ex.: máquina de desenvolvimento). O padrão continua sendo PostgreSQL,
# então nada muda para o ambiente original.
if os.environ.get('DB_ENGINE', 'postgresql') == 'sqlite':
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.sqlite3',
            'NAME': BASE_DIR / 'db.sqlite3',
        }
    }
else:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': os.environ.get('DB_NAME'),
            'USER': os.environ.get('DB_USER'),
            'PASSWORD': os.environ.get('DB_PASSWORD'),
            'HOST': os.environ.get('DB_HOST', 'localhost'),
            'PORT': os.environ.get('DB_PORT', '5432'),
        }
    }

# Cada requisição numa transação só: a gravação do registro e a entrada que os
# signals escrevem em HistoricoAlteracoes são confirmadas ou desfeitas JUNTAS.
# Sem isso (autocommit), uma falha entre as duas deixava a alteração sem rastro.
DATABASES['default']['ATOMIC_REQUESTS'] = True

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator', 'OPTIONS': {'min_length': 10}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# Argon2id na frente: memory-hard (~100 MB por hash), anula a vantagem de
# GPU/ASIC num ataque offline ao banco — recomendação atual da RFC 9106 e do
# OWASP Password Storage Cheat Sheet. PBKDF2 fica na lista SÓ para validar os
# hashes já gravados: no primeiro login bem-sucedido o Django re-hasheia com o
# primeiro da lista, sem reset de senha nem data migration.
PASSWORD_HASHERS = [
    'django.contrib.auth.hashers.Argon2PasswordHasher',
    'django.contrib.auth.hashers.PBKDF2PasswordHasher',
]

LANGUAGE_CODE = 'pt-BR'
TIME_ZONE = 'America/Sao_Paulo'
USE_I18N = True
USE_TZ = True

STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

AUTH_USER_MODEL = 'Auth.Usuario'

FIELD_ENCRYPTION_KEY = os.environ.get('FIELD_ENCRYPTION_KEY')
if not FIELD_ENCRYPTION_KEY:
    raise ValueError("A variável de ambiente FIELD_ENCRYPTION_KEY não está definida.")

# API interna consumida pelo sync-backend (NestJS) do app de campo — nunca
# exposta a sessões de browser, autenticada por segredo compartilhado +
# allowlist de IP (ver Auth.decorators.requer_chave_interna).
MOBILE_SYNC_API_KEY = os.environ.get('MOBILE_SYNC_API_KEY')
if not MOBILE_SYNC_API_KEY:
    raise ValueError("A variável de ambiente MOBILE_SYNC_API_KEY não está definida.")

MOBILE_SYNC_ALLOWED_IPS = [
    ip.strip() for ip in os.environ.get('MOBILE_SYNC_ALLOWED_IPS', '').split(',') if ip.strip()
]

LOGIN_URL = 'Auth:login'
LOGIN_REDIRECT_URL = 'Auth:dashboard'
LOGOUT_REDIRECT_URL = 'Auth:login'

# Segurança de sessão e cookies
SESSION_COOKIE_AGE = 8 * 60 * 60  # 8 horas
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG

# Headers de segurança HTTP (ativos apenas em produção)
# Atrás do nginx o gunicorn recebe HTTP puro — o Django só descobre que a
# requisição ORIGINAL era HTTPS por este header (o nginx o envia; ver
# deploy/nginx-controladoria.conf). Sem esta linha, SECURE_SSL_REDIRECT
# redireciona para HTTPS, o nginx repassa como HTTP, e o ciclo se repete:
# loop infinito de redirect, com o site inacessível.
SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
SECURE_SSL_REDIRECT = not DEBUG
SECURE_HSTS_SECONDS = 31536000 if not DEBUG else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = not DEBUG
SECURE_HSTS_PRELOAD = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True

if DEBUG:
    EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'
else:
    EMAIL_BACKEND = 'django.core.mail.backends.smtp.EmailBackend'
