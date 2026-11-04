# Bruno — Short Link

Abra esta pasta como workspace no Bruno (`workspace.yml`). Você também pode abrir `short-link/` como coleção pelo arquivo `bruno.json`.

Selecione o ambiente **Production**. Ajuste `baseUrl` se o output do Terraform for diferente.

## Links

- **Criar link**: `POST /links`, com `x-api-key` e a URL de `destinationUrl`.
- **Resolver link**: `GET /{{code}}`, sem autenticação.
- **Consultar link**: `HEAD /{{code}}`, sem autenticação.

Preencha `apiKey` na aba de secrets do ambiente. Após criar um link, o script guarda `code` em memória para as próximas requisições. Também é possível preencher `code` manualmente. GET e HEAD não seguem redirects, permitindo inspecionar o `302` e o header `Location`.

## API keys

Crie a API key por invocação direta da Lambda administrativa, usando a AWS CLI ou o console AWS com permissão IAM `lambda:InvokeFunction`. O [README do projeto](../README.md#administração-das-api-keys) contém o exemplo de invocação.

A Lambda administrativa não possui Function URL nem integração com o API Gateway. O workspace contém apenas as rotas de links.

Preencha a chave retornada em `apiKey`, no armazenamento de secrets do Bruno. Apenas o nome do secret é versionado; o valor não deve ser salvo nos arquivos da coleção.

Formato baseado nas referências oficiais de [requisições BRU](https://github.com/usebruno/bruno/blob/main/packages/bruno-lang/v2/tests/fixtures/request.bru) e [variáveis secretas](https://github.com/usebruno/bruno-docs/blob/main/secrets-management/secret-variables.mdx).
