#!/bin/sh
# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
# Run as an OpenBao operator after verifying the application's activation.
set -eu
action="${1:-}"
tenant="${2:-}"
app_id="${3:-}"
mount="${SECRETS_MOUNT:-secret}"
case "$tenant$app_id$mount" in
  *[!a-z0-9_-]*) echo 'Invalid tenant, app UUID or KV mount' >&2; exit 2 ;;
esac
printf '%s\n' "$tenant" | grep -Eq '^[a-z][a-z0-9-]{0,62}$'
printf '%s\n' "$app_id" | grep -Eq '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
printf '%s\n' "$mount" | grep -Eq '^[a-z][a-z0-9_-]*$'

# The local secrets-init service mounts the operator volume. Elsewhere, use
# the identity of the authenticated OpenBao operator running this script.
if [ -n "${OPERATOR_DIR:-}" ]; then
  BAO_TOKEN="$(awk -F'"' '/"root_token"/{print $4; exit}' "$OPERATOR_DIR/init.json")"
  : "${BAO_TOKEN:?missing local OpenBao operator token}"
  export BAO_TOKEN
fi

name="junctura-connection-$tenant-$app_id"
role="auth/approle/role/$name"
key="tenants/$tenant/connections/$app_id"
path="$mount/data/$key"
case "$action" in
  issue)
    # Check that Core has already written the bundle, without printing it.
    bao kv get -mount="$mount" "$key" >/dev/null
    bao policy write "$name" - >/dev/null <<EOF
path "$path" {
  capabilities = ["read"]
}
EOF
    bao write "$role" bind_secret_id=true token_policies="$name" token_no_default_policy=true \
      token_ttl=2m token_explicit_max_ttl=2m secret_id_ttl=24h >/dev/null
    role_id="$(bao read -field=role_id "$role/role-id")"
    secret_id="$(bao write -field=secret_id "$role/secret-id" metadata="{\"junctura_bundle\":\"$path\"}")"
    printf 'JUNCTURA_OPENBAO_ROLE_ID=%s\nJUNCTURA_OPENBAO_SECRET_ID=%s\n' "$role_id" "$secret_id"
    ;;
  revoke)
    bao delete "$role" >/dev/null
    bao policy delete "$name" >/dev/null
    ;;
  *) echo 'Usage: provision-app-bootstrap.sh issue|revoke TENANT APP_UUID' >&2; exit 2 ;;
esac
