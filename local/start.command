#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null || ! node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)'; then
  print 'Установите Node.js 20 или новее и повторите запуск.'
  read -r '?Нажмите Enter, чтобы закрыть окно. '
  exit 1
fi
exec node ./server.mjs --open
