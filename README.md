# short-link

Encurtador de links com backend Node.js, duas funções AWS Lambda e DynamoDB. O endereço público será `https://link.lucas-tavares.com`.

Backend implementado em Node.js, com infraestrutura descrita em Terraform. Alterações locais só entram em produção após um deploy explícito.

## Requisitos

- Apenas backend, sem interface web.
- Leitura pública: qualquer pessoa com o link pode acessar o redirecionamento, sem API key ou login.
- Criação de links autenticada pelo header `x-api-key`.
- Novos códigos de oito caracteres aleatórios em `[a-z0-9]`. Exemplo: `https://link.lucas-tavares.com/abcd1234`. Códigos antigos de seis letras continuam funcionando.
- O campo opcional `code` permite escolher um código e substituir seu destino e opções quando já existir. A API key proprietária pode substituí-lo, mesmo expirado. Outra chave válida só pode assumir o código após a exclusão da chave proprietária.
- Sem `code`, a mesma URL com as mesmas opções retorna o código existente enquanto ele estiver disponível, inclusive entre API keys diferentes e pedidos simultâneos.
- Exatamente duas Lambdas: uma para criar e resolver links; outra para criar, listar e excluir API keys.
- Administração das API keys exclusivamente por invocação direta da Lambda, autorizada por IAM. Sem endpoint HTTP para essa administração.
- Infraestrutura Terraform seguindo o modelo do projeto `../web-streaming`.

## Arquitetura

```mermaid
flowchart LR
    client[Cliente] --> dns[link.lucas-tavares.com]
    dns --> api[API Gateway HTTP API]
    api --> links[Lambda short-link-links]
    links --> urls[(DynamoDB: links)]
    links --> keys[(DynamoDB: api-keys)]
    admin[Operador com IAM] --> manager[Lambda short-link-api-keys]
    manager --> keys
    client -. após receber o redirect .-> destination[Destino original]
```

O Route 53 resolve o domínio para o domínio personalizado regional do API Gateway, com HTTPS e certificado ACM. O DNS não autentica requisições. O API Gateway encaminha apenas as rotas públicas de resolução e a rota de criação para a Lambda de links.

A Lambda administrativa não terá integração com API Gateway, Function URL ou permissão pública de invocação. Sua autorização será a permissão IAM `lambda:InvokeFunction` do operador, via AWS CLI ou SDK. A API key do encurtador não concede essa permissão administrativa.

## Redirecionamento

Ao acessar um código existente, o encurtador retorna `302 Found` com a URL original no header `Location`. O cliente segue esse endereço e acessa o destino diretamente.

A responsabilidade do encurtador é armazenar a associação entre URL e código e retornar o redirecionamento. A URL original será preservada exatamente, incluindo query string e ordem dos parâmetros. Não serão acrescentados parâmetros da requisição ao endereço curto. A resposta usará `Cache-Control: no-store`.

## API HTTP

Base: `https://link.lucas-tavares.com`.

| Método e rota  | Autenticação | Comportamento                                                                       |
| -------------- | ------------ | ----------------------------------------------------------------------------------- |
| `POST /links`  | `x-api-key`  | Cria, substitui um código informado ou recupera a associação automática disponível. |
| `GET /{code}`  | Pública      | Retorna `302 Found` para a URL original.                                            |
| `HEAD /{code}` | Pública      | Retorna o mesmo status e os headers do `GET`, sem corpo.                            |

Não haverá endpoints HTTP para gerenciar API keys. Não há rotas dedicadas para listar, editar ou excluir links; a substituição usa `POST /links` com `code`.

### Criar ou recuperar um link

```http
POST /links HTTP/1.1
Host: link.lucas-tavares.com
Content-Type: application/json
x-api-key: <API_KEY>

{
  "url": "https://example.com/recurso?parametro=valor"
}
```

Uma nova associação retorna `201 Created`:

```json
{
  "code": "abcd1234",
  "shortUrl": "https://link.lucas-tavares.com/abcd1234",
  "created": true
}
```

Sem `code`, uma associação disponível com a mesma URL e as mesmas opções retorna `200 OK`, com o mesmo `code` e `shortUrl`, e `created: false`. Repetições também exigem API key válida. A deduplicação é global; não é separada por chave. Um link esgotado pode ser recriado com um novo código; o antigo permanece indisponível.

Parâmetros opcionais no JSON de criação:

| Campo         | Formato                                                                                      | Padrão                             |
| ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- |
| `code`        | String de 1 a 64 caracteres em `[a-z0-9_-]`, começando por letra ou número.                  | Código aleatório quando omitido.   |
| `expiresAt`   | Data futura UTC em ISO 8601, como `2099-01-01T00:00:00Z` ou com três casas de milissegundos. | Sem expiração quando omitido.      |
| `maxAccesses` | Inteiro positivo seguro; `1` cria um link de uso único.                                      | Acessos ilimitados quando omitido. |

Exemplo: `{"url":"https://example.com/recurso","expiresAt":"2099-01-01T00:00:00Z","maxAccesses":1}`. `null` não representa um valor ilimitado: omita o campo.

Para manter um endereço fixo, informe `code`:

```json
{
  "url": "https://example.com/recurso-atual",
  "code": "meu-link"
}
```

Se o código não existir, retorna `201` e `created: true`. Se existir, retorna `200` e `created: false`, substituindo integralmente o destino e as opções, mesmo que o código tenha sido gerado automaticamente, esteja expirado ou esgotado. Opções omitidas removem os limites anteriores; o contador de acessos volta a zero. Enquanto a chave proprietária existir, somente ela pode substituir o link, mesmo expirado. Se ela for excluída, outra API key válida poderá substituir o código, expirado ou não, e passará a ser a proprietária (`createdByKeyId`). Fora dessa exceção, outra chave recebe `403`, sem alterar o link. A deduplicação automática entre chaves não transfere a propriedade do código. Em concorrência, a última gravação bem-sucedida define o destino.

Códigos informados não participam da deduplicação automática por URL: informar `code` sempre grava nesse código, mesmo que já exista outro link para a mesma URL. Uma criação sem `code` nunca reutiliza um código que sofreu substituição explícita.

Cada resposta de redirecionamento autorizada por `GET` ou `HEAD` consome um acesso dos links limitados, inclusive prévias de aplicativos e verificações automatizadas. O contador limita respostas emitidas pelo encurtador; não confirma que o cliente visitou o destino. O consumo é atômico para que requisições concorrentes não ultrapassem o máximo. Um acesso consumido não é devolvido se a resposta se perder na rede.

O campo `url` deve ser uma string de URL absoluta HTTP ou HTTPS, com no máximo 8 KiB em UTF-8. Não serão aceitos espaços literais, caracteres de controle, credenciais embutidas (`usuario:senha@host`) nem o próprio domínio do encurtador como destino. Não haverá consulta ao destino para testar disponibilidade.

URLs serão comparadas pelo texto exato enviado, sem normalização, remoção de fragmentos, decodificação ou reordenação dos parâmetros. Assim, `https://example.com/a?x=1&y=2` e `https://example.com/a?y=2&x=1` são URLs diferentes. Essa regra preserva o texto exato da URL recebida.

### Resolver um link

```http
GET /abcd1234 HTTP/1.1
Host: link.lucas-tavares.com
```

```http
HTTP/1.1 302 Found
Location: https://example.com/recurso?parametro=valor
Cache-Control: no-store
```

Códigos gerados automaticamente usam `[a-z0-9]{8}`. A resolução também aceita os códigos personalizados descritos acima e os legados `[a-z]{6}`. Código inexistente, inválido, expirado ou com acessos esgotados retorna `404`, sem revelar se já existiu. A query string do endereço curto não altera o destino armazenado. Não haverá login, validação de identidade do leitor ou restrição por API key na resolução.

### Respostas de erro

| Status | Situação                                                                                                  |
| ------ | --------------------------------------------------------------------------------------------------------- |
| `400`  | JSON, URL, `code`, `expiresAt` ou `maxAccesses` inválido.                                                 |
| `401`  | API key ausente, inválida ou excluída na criação.                                                         |
| `403`  | API key válida sem permissão para substituir um código cuja chave proprietária ainda existe.              |
| `404`  | Código inexistente, inválido, expirado, esgotado ou rota inexistente.                                     |
| `413`  | Corpo da requisição acima do limite da aplicação de 16 KiB.                                               |
| `415`  | Criação sem `Content-Type: application/json`.                                                             |
| `429`  | IP bloqueado pela aplicação ou throttling do API Gateway. Na aplicação inclui `Retry-After`.              |
| `503`  | Falha transitória no armazenamento ou tentativas de alocação de código esgotadas; o cliente pode repetir. |
| `500`  | Falha interna inesperada.                                                                                 |

Erros da aplicação terão JSON com `error` e `requestId`, sem stack trace, API key ou URL de destino. Erros produzidos diretamente pelo API Gateway podem ter outro formato. A API não fará cache de respostas autenticadas.

## Bruno

O workspace em [`bruno/`](bruno/README.md) contém as requisições de criação e resolução de links (`POST`, `GET` e `HEAD`). A administração de API keys fica fora do Bruno, por invocação direta da Lambda com IAM, via CLI ou console AWS. Abra `bruno/workspace.yml`, selecione o ambiente **Production** e configure os secrets conforme o README da coleção.

## Administração das API keys

Função prevista: `short-link-api-keys`. Invocação síncrona (`RequestResponse`), com um objeto JSON de entrada.

Os comandos abaixo usam AWS CLI v2 e `jq`, com autenticação IAM do perfil/SSO configurado:

```sh
npm run api-key:add -- "integracao"
npm run api-key:list
npm run api-key:delete -- "UUID-DA-CHAVE"
```

O script `scripts/api-key.sh` lê `.env.deploy` e `.env`, com prioridade para as variáveis exportadas no terminal. Usa `API_KEYS_FUNCTION_NAME`, `AWS_REGION` e `AWS_PROFILE`. A criação exige um nome, e a exclusão exige o `keyId` UUID retornado pela criação ou listagem. O resultado é exibido como JSON; erros da AWS ou da aplicação encerram o comando com falha. A chave completa aparece na saída de criação; o arquivo temporário da resposta é removido ao terminar.

| Ação    | Payload                                   | Resultado                                                                         |
| ------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| Criar   | `{"action":"create","name":"integracao"}` | `keyId`, `name`, `createdAt` e a API key completa, exibida apenas nessa resposta. |
| Listar  | `{"action":"list"}`                       | `items` com todas as chaves, contendo `keyId`, `name` e `createdAt`.              |
| Excluir | `{"action":"delete","keyId":"..."}`       | Confirma a exclusão; repetir a operação será permitido.                           |

`name` será obrigatório, com 1 a 100 caracteres após remover espaços das extremidades. Nomes não serão identificadores únicos. A listagem retornará todas as chaves em uma única resposta, sem paginação ou ordenação garantida.

A API key terá um identificador público e um segredo aleatório de 32 bytes gerado com `node:crypto`. A tabela guardará o identificador e o hash SHA-256 da chave completa, além de nome e data. O segredo original não será persistido nem poderá ser recuperado pela listagem. A validação usará comparação de hashes em tempo constante.

Excluir uma chave impedirá novas autorizações de criação com ela; requisições que já tiverem sido autorizadas poderão terminar. Não haverá cache de autorização entre invocações. Links criados antes da exclusão continuarão públicos e funcionando.

Exemplo de invocação administrativa, após a implementação e o deploy:

```sh
umask 077
aws lambda invoke \
  --profile lucas-personal \
  --region sa-east-1 \
  --function-name short-link-api-keys \
  --invocation-type RequestResponse \
  --cli-binary-format raw-in-base64-out \
  --payload '{"action":"create","name":"integracao"}' \
  /tmp/short-link-key-created.json
```

O arquivo de resposta de criação conterá o segredo. Guardá-lo em um gerenciador de segredos e remover a cópia temporária após o uso. Não versionar esse arquivo. O operador deve conferir o payload de resposta e eventuais erros de execução; sucesso na chamada AWS não significa necessariamente sucesso da operação.

## Persistência e concorrência

Serão usadas duas tabelas DynamoDB na classe `STANDARD`, com capacidade provisionada (`PROVISIONED`), inicialmente com 1 RCU e 1 WCU por tabela, sem Auto Scaling.

Essa configuração prioriza o Free Tier para o uso pessoal previsto: a AWS inclui até 25 RCUs e 25 WCUs provisionadas e 25 GB de armazenamento Standard na franquia gratuita do DynamoDB. O projeto provisionará, ao todo, 2 RCUs e 2 WCUs. A gratuidade depende da franquia disponível na conta; esses limites não são exclusivos deste projeto. Referência: [preços do DynamoDB](https://aws.amazon.com/dynamodb/pricing/).

Não serão habilitados PITR, backups pagos, Streams, réplicas globais ou índices secundários. Será usada a criptografia padrão com chave pertencente à AWS, sem chave KMS gerenciada pelo cliente. A capacidade inicial favorece custo mínimo e baixo volume; picos podem sofrer throttling e serão tratados pelas tentativas limitadas. Se a franquia gratuita já estiver consumida, o modo sob demanda deverá ser reavaliado para o baixo volume de acessos previsto.

### Rate limit por IP

A resolução pública aplica a regra de `back/src/shared/rate-limit.mjs`, usando `requestContext.http.sourceIp` do API Gateway. Headers fornecidos pelo cliente não substituem esse IP.

- Janela móvel dos últimos 60 segundos. Tentativas de códigos inválidos, inexistentes, expirados ou esgotados contam como erros. O quinto erro ativa o bloqueio e já retorna `429`.
- Penalidades de 30, 60, 120, 240, 480 e 900 segundos. Cada tentativa durante um bloqueio avança a penalidade e redefine seu fim a partir do horário da tentativa. No teto, cada tentativa mantém mais 15 minutos de bloqueio, mesmo se usar um código válido.
- Após o desbloqueio, erros ainda dentro da janela continuam contando. O nível da penalidade só é zerado após 15 minutos sem novas falhas e sem bloqueio ativo. Acertos não alteram os registros.
- Respostas `429` incluem `Retry-After` com os segundos até o novo fim do bloqueio. `HEAD` retorna os mesmos headers, sem corpo.
- Falhas de armazenamento retornam `503` e não são registradas como erros do IP. Sem IP de origem confiável, a resolução retorna `503`.
- Um registro `IP#<sha256-do-ip>` na tabela de links guarda até cinco horários de erro, nível, fim do bloqueio e versão. Atualizações condicionais tratam concorrência entre Lambdas. Não há histórico de todos os acessos, tabela adicional, TTL ou rotina de limpeza: registros vencidos são ignorados logicamente e reaproveitados no próximo erro.

O throttling geral do API Gateway permanece como proteção de volume. A regra por IP acrescenta leituras por resolução e escritas por erro ou tentativa bloqueada no DynamoDB. IPs compartilhados dividem a mesma penalidade; esta proteção não impede tentativas distribuídas entre vários IPs.

### Tabela de links

Tabela `short-link-links`, com chave de partição string `pk` e três tipos de item:

| Chave                        | Atributos principais                                             | Uso                                                            |
| ---------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `CODE#abcd1234`              | `url`, `createdAt`, `createdByKeyId`, opções e contador opcional | Resolver o código por leitura direta.                          |
| `URL#<hash-da-url-e-opções>` | `url`, `code`, `createdAt`                                       | Encontrar a associação existente e garantir unicidade por URL. |

Itens `IP#<sha256-do-ip>` guardam o estado do rate limit descrito acima. Links sem opções mantêm o hash original da URL para compatibilidade; com opções, o hash inclui a URL e as opções normalizadas.

Não haverá `Scan` na criação ou na resolução de links, nem índice secundário necessário para esses acessos. As leituras de deduplicação serão fortemente consistentes.

Fluxo de criação sem `code`:

1. Validar a API key, a URL e as opções recebidas.
2. Calcular o hash da URL e das opções e buscar `URL#<hash>`.
3. Se houver associação disponível para a mesma URL e opções e o código não tiver sido substituído explicitamente, retornar o código existente com `200`.
4. Gerar oito caracteres `[a-z0-9]` com aleatoriedade criptográfica uniforme. O espaço tem `36^8 = 2.821.109.907.456` combinações.
5. Gravar `CODE#...` e `URL#...` em uma transação condicional, sem sobrescrever códigos existentes. Para substituir uma associação esgotada, conferir atomicamente seu código anterior.
6. Se outra criação tiver vencido para a mesma URL e opções, ler a associação de forma consistente e retornar seu código disponível. Se houver conflito transitório ainda sem associação visível, repetir com espera limitada.
7. Se o conflito for um código já usado por outra URL, gerar outro e tentar novamente, sem sobrescrever a associação existente.

As tentativas serão limitadas e usarão backoff com jitter. Ao esgotá-las, retornar `503` sem deixar uma associação parcial. O algoritmo não tratará toda falha de transação como colisão: erros de infraestrutura serão classificados separadamente.

A [documentação de transações do DynamoDB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html) descreve a atomicidade de `TransactWriteItems` e os conflitos concorrentes. As duas escritas condicionais na mesma transação garantem que pedidos iguais não produzam códigos diferentes persistidos.

Além do hash, o texto da URL será conferido ao reutilizar uma associação. Uma eventual divergência para o mesmo hash deverá gerar erro interno, nunca devolver um destino diferente.

Com `code`, a aplicação grava apenas `CODE#...`, com uma versão única e condições sobre o `createdByKeyId` e a versão anterior para serializar substituições concorrentes. Ao assumir um código, a mesma transação verifica que a chave proprietária anterior não existe na tabela de API keys. Não cria associação `URL#...`; associações automáticas antigas que apontam para esse código são ignoradas. O consumo de acessos verifica a versão lida para não debitar um link substituído enquanto a resolução estava em andamento.

A expiração é conferida na aplicação, inclusive na operação condicional que consome acessos. Não depende de remoção física por TTL. Códigos expirados e esgotados permanecem reservados na geração automática; uma requisição autenticada com `code` pode substituí-los explicitamente. O contador só existe nos links com `maxAccesses`; os ilimitados não recebem escritas por acesso.

### Tabela de API keys

Tabela `short-link-api-keys`, com chave de partição `keyId`. Cada item terá `keyId`, `keyHash`, `name` e `createdAt`.

A Lambda de links terá apenas permissões de leitura e verificação de condições (`ConditionCheckItem`) nessa tabela. A Lambda administrativa poderá criar, listar e excluir seus registros, sem acesso à tabela de links. A listagem administrativa usará `Scan` com projeção apenas dos metadados públicos e retornará todos os itens em uma única resposta, sem expor o hash.

## Infraestrutura

O modelo será o Terraform de `../web-streaming`, adaptado para este backend:

| Item            | Definição                                                                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Região          | `sa-east-1`, como padrão do projeto de referência.                                                                                                                           |
| Runtime         | Node.js 22, arquitetura ARM64.                                                                                                                                               |
| Lambdas         | `short-link-links` e `short-link-api-keys`.                                                                                                                                  |
| Exposição HTTP  | API Gateway HTTP API, payload v2.0.                                                                                                                                          |
| Domínio         | `link.lucas-tavares.com`.                                                                                                                                                    |
| DNS             | Zona pública Route 53 existente `lucas-tavares.com`, consultada pelo Terraform.                                                                                              |
| TLS             | Certificado ACM dedicado na região do API Gateway, validado por DNS.                                                                                                         |
| Banco           | Duas tabelas DynamoDB `STANDARD`, modo `PROVISIONED`, 1 RCU e 1 WCU por tabela, sem Auto Scaling, PITR ou backups pagos, com proteção Terraform contra destruição acidental. |
| IAM             | Uma execution role por Lambda, com permissões específicas para suas tabelas e logs.                                                                                          |
| Logs            | CloudWatch com retenção de 14 dias.                                                                                                                                          |
| Limites HTTP    | Throttling inicial de 10 requisições/s, burst 20, configurável.                                                                                                              |
| State Terraform | Local e ignorado pelo Git, seguindo o projeto de referência.                                                                                                                 |

O Terraform criará o subdomínio na zona existente e um certificado ACM na mesma região do API Gateway. O `web-streaming` serve como referência de infraestrutura; os recursos deste projeto serão independentes.

As API keys serão geradas em execução pela Lambda administrativa; seus valores não serão inputs, outputs ou recursos do Terraform. Os logs não deverão conter corpo de requisição, `x-api-key`, resposta de criação de chave, URL de destino ou header `Location`. Os access logs registrarão identificador da requisição, rota, status e latência.

O acesso público aos códigos é intencional. O código aleatório identifica o link. Um redirect permite ao cliente conhecer a URL de destino.

## Organização prevista

```text
back/
  src/
    links.mjs             # Handler HTTP: criação e redirecionamento
    api-keys.mjs          # Handler administrativo por invocação direta
    shared/               # Validação, acesso ao DynamoDB e geração de códigos
  test/                   # Testes dos contratos e da concorrência
  dist/                   # Bundles gerados, fora do Git
infra/
  versions.tf             # Providers e versões
  variables.tf            # Inputs
  storage.tf              # DynamoDB
  api.tf                  # Lambdas, IAM, API Gateway e logs
  domain.tf               # Route 53 e ACM
  outputs.tf              # URLs e nomes públicos dos recursos
  terraform.tfvars.example
scripts/                  # Build, validação e deploy
.env.deploy.example       # Perfil, região e inputs Terraform sem segredos
README.md
```

## Implantação prevista

O ambiente seguirá o padrão do `web-streaming`: Node.js 22.16+, npm, AWS CLI v2, Terraform 1.11+ e autenticação AWS por perfil/SSO ou role. O perfil de referência é `lucas-personal`; a aplicação não exigirá chaves de acesso estáticas em arquivo.

A implementação deverá disponibilizar instalação reproduzível com lockfile, build dos dois handlers, testes, validação Terraform e comandos separados para gerar plano e aplicar a infraestrutura. O domínio e as Lambdas só estarão disponíveis após o apply na conta AWS correta e a validação do certificado/DNS.

O deploy deverá publicar os bundles das duas funções e expor como outputs a URL base, os nomes das funções, as tabelas e a região. A primeira API key será criada por invocação direta da Lambda administrativa após o provisionamento.

O state local e seus backups precisam ser preservados fora do Git. As variáveis locais, credenciais, arquivos de resposta com API keys, bundles e planos Terraform também deverão ser ignorados. Não haverá pipeline de CI nesta etapa.

## Configuração após o deploy

Os outputs do ambiente de produção foram salvos no `.env` local, ignorado pelo Git:

| Variável local           | Valor                            |
| ------------------------ | -------------------------------- |
| `BASE_URL`               | `https://link.lucas-tavares.com` |
| `AWS_REGION`             | `sa-east-1`                      |
| `LINKS_FUNCTION_NAME`    | `short-link-links`               |
| `API_KEYS_FUNCTION_NAME` | `short-link-api-keys`            |
| `LINKS_TABLE`            | `short-link-links`               |
| `KEYS_TABLE`             | `short-link-api-keys`            |

Para disponibilizar essas variáveis no terminal atual:

```sh
set -a
source .env
set +a
```

O Terraform já configura `BASE_URL`, `LINKS_TABLE` e `KEYS_TABLE` nas Lambdas correspondentes. O `.env` serve para uso local; os comandos de infraestrutura continuam lendo `.env.deploy`.

O ambiente **Production** do Bruno usa a mesma URL base. A API key deve ser criada por invocação direta da Lambda administrativa e preenchida no secret `apiKey` do Bruno.

## Validação da implementação

- Criação autenticada de URL nova retorna oito caracteres `[a-z0-9]` e `201`.
- Repetições sequenciais e concorrentes da mesma URL e opções retornam o mesmo código disponível, inclusive entre API keys diferentes.
- Códigos explícitos criam ou substituem destinos e opções, reiniciam acessos e não contaminam a deduplicação automática.
- Colisões na geração automática são repetidas sem sobrescrever links; falhas de transação não deixam itens parciais.
- URL original é devolvida integralmente no `Location`, sem normalização de query string.
- `GET` e `HEAD` resolvem sem chave; códigos ausentes ou inválidos retornam `404`.
- API keys ausentes, inválidas e excluídas impedem criação, inclusive a recuperação de uma associação existente por `POST /links`.
- A chave completa só aparece na resposta administrativa de criação; a listagem retorna todas as chaves sem expor segredo ou hash.
- Exclusão de chave não interrompe a resolução dos links existentes.
- Rotas HTTP não permitem administrar chaves.
- Limites, formatos de entrada e respostas de erro seguem o contrato acima.
- Após deploy: validar DNS/TLS, criar chave por IAM, criar um link e testar `curl` sem seguir redirect para conferir o `Location`.
