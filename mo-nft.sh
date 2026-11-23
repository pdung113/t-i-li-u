#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Cài Node.js từ https://nodejs.org rồi chạy lại."
  exit 1
fi
if [ ! -d node_modules ]; then
  npm install
fi
echo "Mở http://127.0.0.1:4173"
node app/server.js
