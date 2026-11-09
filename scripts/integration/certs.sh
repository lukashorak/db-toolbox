#!/usr/bin/env bash
# Creates a throwaway CA and a server certificate for localhost (valid two days), plus an unrelated
# CA for "untrusted issuer" tests. Output: $1 (default .integration/certs).
set -euo pipefail
dir="${1:-.integration/certs}"
mkdir -p "$dir"
cd "$dir"
if [ -f server.crt ] && openssl x509 -checkend 3600 -noout -in server.crt >/dev/null 2>&1; then exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=Workbench Test CA" 2>/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -keyout other-ca.key -out other-ca.crt -days 2 -subj "/CN=Unrelated Test CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost" 2>/dev/null
printf 'subjectAltName=DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' > server.ext
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 2 -extfile server.ext 2>/dev/null
# Readable by the database processes inside the containers; these keys protect nothing.
chmod 644 server.key
