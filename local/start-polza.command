#!/bin/zsh
set -eu
cd "${0:A:h}/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null || ! node -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'; then
  print 'Установите Node.js 24 или новее и повторите запуск.'
  read -r '?Нажмите Enter, чтобы закрыть окно. '
  exit 1
fi
if [[ ! -f .env.polza.local ]]; then
  print 'Сначала настройте Polza AI: инструкция в local/README.md.'
  read -r '?Нажмите Enter, чтобы закрыть окно. '
  exit 1
fi
exec node --env-file=.env.polza.local ./local/server.mjs --open
