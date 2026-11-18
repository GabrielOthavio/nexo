# Controladoria (Django) — Instalação e uso

Núcleo administrativo do sistema: interface web, modelo de domínio, RBAC por
perfil, trilha de auditoria automática e a API interna consumida pelo
`sync-backend` do app de campo. Visão geral do projeto no
[README da raiz](../README.md).

## Requisitos

- Python 3.12 ou superior
- PostgreSQL 12+ **ou** SQLite (padrão para desenvolvimento local — sem
  servidor de banco)

## Instalação

### Windows

```powershell
cd Controladoria
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy config\.env.example config\.env
```

### Linux / macOS

```bash
cd Controladoria
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp config/.env.example config/.env
```

Ou use o `install.sh` (Linux), que faz os passos acima, aplica as migrations e
roda o `seed_demo`.

### Configurar `config/.env`

O arquivo [`config/.env.example`](config/.env.example) documenta cada variável.
As três chaves são obrigatórias e o servidor **recusa subir** sem elas:

```powershell
# gera as três de uma vez
.\.venv\Scripts\python.exe -c "from django.core.management.utils import get_random_secret_key as k; from cryptography.fernet import Fernet; import secrets; print('SECRET_KEY=' + repr(k())); print('FIELD_ENCRYPTION_KEY=' + repr(Fernet.generate_key().decode())); print('MOBILE_SYNC_API_KEY=' + repr(secrets.token_urlsafe(32)))"
```

| Variável | O que é |
|---|---|
| `SECRET_KEY` | chave do Django (sessões, CSRF) |
| `FIELD_ENCRYPTION_KEY` | chave Fernet dos campos cifrados (CPF, telefone, endereço, descrição do achado). **Perdê-la torna esses dados ilegíveis.** |
| `MOBILE_SYNC_API_KEY` | segredo compartilhado com o `sync-backend`; precisa ser **idêntico** nos dois `.env` |
| `MOBILE_SYNC_ALLOWED_IPS` | allowlist de IPs de origem da API interna (vazio = desligada) |
| `DB_ENGINE` | `sqlite` (padrão para dev) ou `postgresql` |
| `DB_*` | credenciais do PostgreSQL, só quando `DB_ENGINE=postgresql` |
| `DEBUG`, `ALLOWED_HOSTS` | padrão Django; `DEBUG=False` liga HSTS, cookies `Secure` e redirect HTTPS |

### Banco e dados de exemplo

```powershell
.\.venv\Scripts\python.exe manage.py migrate
.\.venv\Scripts\python.exe manage.py seed_demo
```

`seed_demo` é idempotente. Cria o perfil "Auditor de Campo", os usuários
abaixo, 3 entidades, 4 auditorias (3 abertas + 1 concluída), 10 etapas e 3
achados — o suficiente para exercitar o app de campo. `--flush` apaga os dados
de domínio antes de semear.

| Usuário | Senha | Perfil |
|---|---|---|
| `admin` | `Admin@123` | Chefe (superusuário) |
| `auditor.campo` | `mudar123` | Auditor de Campo |

**Troque essas senhas antes de qualquer uso fora de desenvolvimento.**

## Executar

```powershell
.\.venv\Scripts\python.exe manage.py runserver        # http://127.0.0.1:8000
```

Para o `sync-backend` alcançar a API interna, ele precisa do
`DJANGO_API_BASE_URL` apontando para este servidor e do mesmo
`MOBILE_SYNC_API_KEY`.

## Testes

```powershell
.\.venv\Scripts\python.exe manage.py test Auth
```

122 testes em [`Auth/tests/`](Auth/tests/), rodando em SQLite em memória:

| Arquivo | Cobre |
|---|---|
| `test_chave_interna.py` | o decorator `requer_chave_interna`: header ausente/errado, prefixo, não-ASCII, allowlist de IP, sessão de browser não substitui a chave |
| `test_rbac.py` | `tem_permissao`, `profundidade` (inclusive ciclo), hash de senha Argon2id e migração transparente a partir de PBKDF2 |
| `test_determinar_resolvedor.py` | os cinco ramos da atribuição de conflito e o desempate por hierarquia |
| `test_api_mobile.py` | os seis endpoints da API interna nos três eixos (perfil, envolvimento, status), idempotência por `origem_mobile_uuid`, conflito por baseline, `[PROTEGIDO]` e autor na trilha |
| `test_api_atualizacoes.py` | o carimbo de versão que alimenta a faixa "chegou dado novo" no web |

Os fixtures usam MD5 como hasher de senha (`hasher_rapido`) para a suíte
rodar em ~1 s; só `HashDeSenhaTest` usa o Argon2 real.

## Comandos de gestão

| Comando | Para quê |
|---|---|
| `seed_demo [--flush]` | dados de demonstração |
| `seed_acoes` | 100 Ações aleatórias para o módulo de ações |
| `vincular_usuario_mobile <username>` | imprime o `UPDATE` que vincula o usuário do Django ao do `sync-backend` |

## Segurança (o que este módulo implementa)

- Senhas em **Argon2id** (`PASSWORD_HASHERS`); hashes PBKDF2 existentes são
  migrados no próximo login sem reset.
- Campos sensíveis em `EncryptedCharField`/`EncryptedTextField` (Fernet).
- Trilha de auditoria por signal em `MODELOS_AUDITAVEIS`, com o campo cifrado
  redigido como `[PROTEGIDO]` e o autor impersonado via `set_current_user`
  quando a escrita vem do app.
- API interna em `Auth/views/api_mobile_views.py`: `@csrf_exempt` **e**
  `@requer_chave_interna` — comparação em tempo constante, allowlist de IP,
  nunca autenticada por sessão.
- Cookies `HttpOnly`; `Secure`/HSTS/redirect HTTPS ativos com `DEBUG=False`.

## Solução de problemas

**`A variável de ambiente X não está definida`** — falta a chave no
`config/.env`. O `load_dotenv()` procura o arquivo a partir de `config/`.

**`UNIQUE constraint failed: Auth_perfil.nome`** ao criar perfis — a migration
`0010` já semeia "Chefe" e "Funcionário"; use outros nomes.

**Quero voltar para PostgreSQL** — `DB_ENGINE=postgresql` no `.env`, preencha
`DB_*`, `createdb controladoria_db`, `migrate`.

**Erro ao instalar `psycopg2-binary` no Linux** —
`sudo apt-get install libpq-dev python3-dev`.
