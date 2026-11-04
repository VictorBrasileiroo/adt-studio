# E0 — Baseline de estabilidade do Setup Recommender

Infraestrutura experimental da issue #333. Base operacional: `d0890d4bae919ffbcefa761bfbceca815a0421ec`.
Branch: `exp/333-setup-recommender-stability`. Trilha SDD: experimento; não destinado a merge como implementação.

O modo padrão prepara e verifica entradas, com **zero chamadas reais à LLM**.
Este trabalho não autoriza a execução paga. Não há alterações em código de produção, prompts,
Decision Specs, sampling, regras de configuração ou criação do livro.

## Pré-requisitos e corpus

Execute na raiz do monorepo, com as dependências já instaladas e Node 20+:

```powershell
pnpm.cmd typecheck
```

Isso também atualiza os pacotes compilados que os imports de produção usam. O experimento
reutiliza `tsx`, Vitest, Zod e `zod-to-json-schema` já instalados; não instala dependências.
No PowerShell, use `pnpm.cmd` se a política de execução bloquear `pnpm.ps1`.

`corpus.json` fixa três IDs, caminhos relativos ao manifesto, idioma da resposta e faixa física
inclusiva. Esse manifesto é local e ignorado pelo Git. `range: null` significa documento
completo, mantendo o sampling da V1. Para criar uma configuração local nova, sem sobrescrever
um manifesto já preenchido:

```powershell
if (!(Test-Path experiments/setup-recommender-stability/corpus.json)) {
  Copy-Item experiments/setup-recommender-stability/corpus.example.json experiments/setup-recommender-stability/corpus.json
}
```

Preencha os caminhos dos PDFs, ranges e idiomas no arquivo local. Selecione três documentos
representativos: storybook, textbook e um caso complexo ou ambíguo. O exemplo público não
contém nomes, caminhos, hashes ou dados dos documentos usados localmente.
`pdf: null` documenta uma entrada ausente e bloqueia a execução. Também é possível usar
`corpus.local.json` com `--corpus`. Para um recorte, informe `start` e `end` com limites reais.

## Preparar e verificar, sem custo

```powershell
pnpm.cmd exec tsx experiments/setup-recommender-stability/e0/run.ts
# Manifesto alternativo, opcional:
pnpm.cmd exec tsx experiments/setup-recommender-stability/e0/run.ts --corpus experiments/setup-recommender-stability/corpus.local.json
```

Cada caso produz três preparações lógicas independentes e compara SHA-256 do PDF, das
evidências e do payload completo. Para evitar refatorar produção, cada preparação executa
uma passagem de evidências independente e uma passagem interna de `recommendSetup` com
modelo capturador. São **seis passagens de evidências por PDF**, três payloads e nenhuma
inferência. O snapshot independente é comparado com textos, imagens e schema do payload.
Não use esse custo de preparação duplicada para medir a latência de produção.

Objetos comuns têm chaves ordenadas; arrays preservam ordem. Imagens entram integralmente
em base64; o schema Zod entra como JSON Schema, sem serializar funções. Instâncias opacas,
valores indefinidos inesperados e sinais de cancelamento são rejeitados. O sinal indefinido
da V1 é excluído explicitamente. `request.json` é uma projeção lógica, não o corpo HTTP.

Uma divergência de hash ou falha de preparação em qualquer caso bloqueia toda a bateria
paga. Hashes iguais numa execução não garantem determinismo em outro ambiente.

## Validar o harness

```powershell
pnpm.cmd exec tsc -p experiments/setup-recommender-stability/e0/tsconfig.json --noEmit
pnpm.cmd exec vitest run --config experiments/setup-recommender-stability/e0/vitest.config.ts
pnpm.cmd exec vitest run --project api apps/api/src/services/setup-recommendation apps/api/src/routes/setup-recommendation.test.ts --project packages packages/types/src/__tests__/setup-recommendation.test.ts packages/pdf/src/__tests__/setup-recommendation-evidence.test.ts
pnpm.cmd lint
```

Os testes novos usam respostas sintéticas em memória e diretórios temporários removidos ao
final. Testes da preparação e paridade usam o PDF de fixture existente, com a LLM substituída.
Os testes estão em config própria, fora da descoberta da suíte raiz, como nos experimentos V2.

## Executar a bateria real — somente após autorização explícita

### Smoke isolado — uma tentativa

```powershell
pnpm.cmd exec tsx experiments/setup-recommender-stability/e0/run.ts --smoke --case storybook --allow-paid
```

Requer autorização explícita, `OPENAI_API_KEY` e o caso configurado no corpus local.
Somente o caso selecionado é preparado e verificado; os outros PDFs podem estar ausentes.
O smoke usa o mesmo payload congelado, factory, modelo e validação da baseline.
Faz uma única tentativa, inclusive se geração ou validação falharem, sem retries.
Sem `--allow-paid`, sem `--case`, com caso inexistente ou flags inválidas, bloqueia antes
de iniciar inferência. `--case` só é aceito junto de `--smoke`.

Saídas ficam em `e0/results/smoke/<UTC>-<UUID>/`, com `mode: smoke` em `run.json` e
`experiment: smoke` no registro individual. O status pode ser `success`, `invalid` ou
`error`; falhas retornam código de saída diferente de zero, após salvar o registro.
Sucesso confirma uma resposta válida para uma chamada; não mede estabilidade nem acurácia.
O arquivo individual contém hashes, provider/modelo/versão, escolhas válidas, tokens,
latência e categoria segura de erro quando disponíveis. Não há `analysis.json` de baseline.
O analisador recusa pastas smoke e exclui registros marcados como smoke mesmo se copiados
para outra pasta ou fornecidos diretamente à função de análise.

### Baseline — comportamento original

Verifique os PDFs, ranges, idiomas e a representatividade do corpus. Configure
`OPENAI_API_KEY` no ambiente sem salvá-la no manifesto ou nos artefatos. Recompile como acima.

```powershell
pnpm.cmd exec tsx experiments/setup-recommender-stability/e0/run.ts --allow-paid
```

Esse comando é **30 tentativas reais: 3 PDFs distintos × 10 repetições**, sequenciais,
sem retries, votação, fallback ou cache de aplicação. Custo monetário e tokens não foram
estimados: dependem do payload e da resposta e ainda não foram medidos.
O modelo e o transporte são os mesmos da V1, via `createSetupRecommendationModel` e
`@adt/llm`: `openai:gpt-5.4-mini`, prompt `adt-config-recommender-poc-v1`.
Temperatura, seed e maxTokens não são acrescentados; as omissões são preservadas.
Não há controle sobre caching interno do provedor ou revisões do alias remoto.

O primeiro payload preparado é reutilizado por referência nas dez chamadas. Mensagens e
partes ficam congeladas; o schema Zod real é preservado e o hash lógico é verificado antes
e depois de cada chamada. Não há nova preparação durante as dez inferências.
O HEAD deve descender da base e o código/dependências relevantes da V1 devem coincidir
com a base. Um commit somente do harness pode ser usado, sem editar a base fixada.

## Artefatos e análise

Cada invocação cria `e0/results/<UTC>-<UUID>/`:

```text
run.json                       # corpus, base/HEAD, ambiente e hashes de proveniência
<case>/preparation.json         # três hashes e resultado da comparação
<case>/evidence.json            # observações, BookProfile, textos e imagens
<case>/request.json             # mensagens, schema e parâmetros lógicos
<case>/repetition-01.json       # apenas no modo pago; até repetition-10.json
analysis.json                  # apenas após concluir o modo pago
```

Arquivos são criados com `wx`; não há retomada que sobrescreva baterias anteriores.
Falhas de preparação geram `blocked.json`. Falha de escrita encerra a bateria.
Resultados parciais podem ser analisados sem repetir as chamadas anteriores:

```powershell
pnpm.cmd exec tsx experiments/setup-recommender-stability/e0/analyze.ts "CAMINHO_DO_DIRETORIO_DA_EXECUCAO"
```

O analisador escreve JSON no stdout. Ele valida o envelope, revalida respostas/citações,
recusa repetições duplicadas e separa PDFs/requisições/commits diferentes.
Para n respostas válidas: denominador = n(n−1)/2; numerador = soma de f(f−1)/2
para cada vetor idêntico. A concordância por dimensão usa a mesma fórmula.
O resumo geral soma numeradores e denominadores dos grupos, sem pares entre PDFs.
Menos de duas respostas válidas produz `proportion: null`. Falhas e respostas inválidas
não entram nos pares. Tokens/latência têm total, média e número de registros disponíveis;
zero é preservado e ausência não vira medição zero. As contagens refletem arquivos existentes,
não tentativas ausentes numa bateria interrompida.

O manifesto preenchido, o relatório técnico local, o finding local e todos os resultados
são ignorados pelo Git, pois podem conter caminhos ou dados derivados dos PDFs.
Não execute `git add -f` nesses diretórios. Respostas inválidas e erros brutos do SDK
não são persistidos; erros recebem categorias seguras. Sucessos guardam a resposta
estruturada validada e as seis escolhas. Há registro de tokens quando o transporte os expõe;
tokens de chamadas que falham antes de retornar podem estar indisponíveis.

Evidências observadas e revisão detalhada ficam nos relatórios locais ignorados pelo Git.
Compartilhe apenas versões explicitamente revisadas para remover informações privadas.
