#!/bin/sh
set -eu

usage() {
  echo 'Uso: npm run api-key:add -- "nome" | npm run api-key:list | npm run api-key:delete -- <key-id>' >&2
  exit 1
}

[ "$#" -ge 1 ] || usage
action=$1
shift
case "$action" in
  add|delete) [ "$#" -eq 1 ] && [ -n "$1" ] || usage ;;
  list) [ "$#" -eq 0 ] || usage ;;
  *) usage ;;
esac

for command in aws jq; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Comando necessário não encontrado: $command" >&2
    exit 1
  }
done

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_dir"

# Exported settings take precedence over the local configuration files.
api_key_profile=${AWS_PROFILE-}
api_key_region=${AWS_REGION-}
api_key_function=${API_KEYS_FUNCTION_NAME-}
set -a
[ ! -f .env.deploy ] || . ./.env.deploy
[ ! -f .env ] || . ./.env
AWS_PROFILE=${api_key_profile:-${AWS_PROFILE-}}
AWS_REGION=${api_key_region:-${AWS_REGION:-sa-east-1}}
API_KEYS_FUNCTION_NAME=${api_key_function:-${API_KEYS_FUNCTION_NAME:-short-link-api-keys}}
set +a
if [ -z "$AWS_PROFILE" ]; then unset AWS_PROFILE; fi
export AWS_REGION API_KEYS_FUNCTION_NAME

case "$action" in
  add)
    payload=$(jq -cn --arg name "$1" '{action: "create", name: $name}')
    ;;
  list)
    payload='{"action":"list"}'
    ;;
  delete)
    if ! jq -en --arg id "$1" '$id | test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")' >/dev/null; then
      echo 'Informe um key-id UUID v4 válido.' >&2
      exit 1
    fi
    payload=$(jq -cn --arg keyId "$1" '{action: "delete", keyId: $keyId}')
    ;;
esac

umask 077
response_dir=$(mktemp -d "${TMPDIR:-/tmp}/short-link-api-key.XXXXXX")
trap 'rm -rf -- "$response_dir"' EXIT
trap 'exit 1' HUP INT TERM

aws lambda invoke \
  --region "$AWS_REGION" \
  --function-name "$API_KEYS_FUNCTION_NAME" \
  --invocation-type RequestResponse \
  --cli-binary-format raw-in-base64-out \
  --payload "$payload" \
  --output json \
  --no-cli-pager \
  "$response_dir/response.json" > "$response_dir/metadata.json"

if ! jq -e '.StatusCode == 200 and .FunctionError == null' "$response_dir/metadata.json" >/dev/null; then
  echo 'A invocação da Lambda falhou.' >&2
  cat "$response_dir/response.json" >&2
  exit 1
fi

if ! jq -e 'type == "object" and .error == null' "$response_dir/response.json" >/dev/null; then
  echo 'A operação de API key falhou.' >&2
  cat "$response_dir/response.json" >&2
  exit 1
fi

jq . "$response_dir/response.json"
