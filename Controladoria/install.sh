#!/bin/bash
# Instalador do núcleo Django (Linux). Faz o que o README_INSTALL.md descreve:
# venv em .venv/, dependências do requirements.txt, migrations e dados de
# exemplo. Rode a partir de qualquer diretório.
set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${YELLOW}ℹ${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$PROJECT_DIR/.venv"
cd "$PROJECT_DIR"

echo "=========================================="
echo "  Instalador - Sistema de Controladoria"
echo "=========================================="
echo ""

command -v python3 >/dev/null || { err "Python 3 não encontrado."; exit 1; }
ok "Python: $(python3 --version)"

if ! python3 -m venv --help >/dev/null 2>&1; then
    info "Instalando python3-venv..."
    sudo apt-get update && sudo apt-get install -y python3-venv
fi

if [ ! -d "$VENV" ]; then
    info "Criando ambiente virtual em $VENV"
    python3 -m venv "$VENV"
fi
ok "Ambiente virtual: $VENV"

info "Instalando dependências (requirements.txt)..."
"$VENV/bin/pip" install --upgrade pip --quiet
"$VENV/bin/pip" install -r requirements.txt --quiet
ok "Dependências instaladas"

if [ ! -f config/.env ]; then
    err "config/.env não existe."
    info "Copie config/.env.example para config/.env e preencha as chaves (instruções no arquivo)."
    exit 1
fi
ok "config/.env encontrado"

# Só exige PostgreSQL se o .env pedir por ele.
DB_ENGINE="$(grep -E '^DB_ENGINE=' config/.env | cut -d= -f2 | tr -d "\"' ")"
if [ "${DB_ENGINE:-postgresql}" = "postgresql" ]; then
    command -v psql >/dev/null || { err "PostgreSQL não encontrado (ou use DB_ENGINE=sqlite no .env)."; exit 1; }
    DB_NAME="$(grep -E '^DB_NAME=' config/.env | cut -d= -f2 | tr -d "\"' ")"
    if ! psql -lqt | cut -d'|' -f1 | grep -qw "${DB_NAME:-controladoria_db}"; then
        info "Criando banco ${DB_NAME:-controladoria_db}..."
        createdb "${DB_NAME:-controladoria_db}" || err "Crie manualmente: createdb ${DB_NAME:-controladoria_db}"
    fi
    ok "PostgreSQL: banco ${DB_NAME:-controladoria_db}"
else
    ok "Banco: SQLite (db.sqlite3)"
fi

info "Aplicando migrations..."
"$VENV/bin/python" manage.py migrate --noinput
ok "Migrations aplicadas"

info "Semeando dados de exemplo (seed_demo)..."
"$VENV/bin/python" manage.py seed_demo
ok "Dados de exemplo criados"

echo ""
echo "=========================================="
echo "  ✓ Instalação concluída"
echo "=========================================="
echo ""
echo "Iniciar:   $VENV/bin/python manage.py runserver"
echo "Acessar:   http://127.0.0.1:8000/"
echo "Testes:    $VENV/bin/python manage.py test Auth"
echo ""
echo "Logins (troque antes de uso real):"
echo "  admin / Admin@123   |   auditor.campo / mudar123"
