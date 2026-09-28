# Dashboard de investimentos fictícios

Sistema local que coleta notícias e preços reais, classifica as notícias com o **JEV** e faz uma análise por ação (ambos pela **OpenRouter**). A partir disso, opera **carteiras fictícias** de US$ 10.000 com regras fixas e mede se a estratégia ganha das referências.

> Nenhuma ordem real é enviada. O objetivo é testar a estratégia, sem pressupor que ela dê lucro.

## Situação das etapas do plano

| Etapa | Situação |
|---|---|
| 1. Validar integrações | Clientes prontos e `npm run validate` escrito. **Falta rodar com as suas chaves**: o ambiente em que o código foi escrito não tinha acesso de rede a Finnhub, Alpaca e OpenRouter. |
| 2. Coleta | Banco SQLite, deduplicação em eventos, histórico e coleta incremental idempotente. |
| 3. Análise | JEV + analista por ação, com saída validada por Zod, fontes e versões registradas e cache. |
| 4. Simulador | Caixa, reservas, ordens, execuções, custos, desdobramentos e dividendos. Tudo testado. |
| 5. Dashboard | Seis telas em português, com o registro do que se sabia no momento de cada previsão. |
| 6. Experimentos | Carteiras A (1 pregão) e B (5 pregões) criadas automaticamente. Começam no próximo pregão. |
| 7. Avaliar | Métricas, referências e sensibilidade a custos prontas. **A conclusão depende de semanas de dados reais.** |

A entrega só estará demonstrada quando uma notícia **real** percorrer o fluxo completo: coleta → classificação → previsão → operação fictícia → resultado. No modo mock esse fluxo roda de ponta a ponta (teste `tests/e2e.test.ts`), mas com dados sintéticos.

## Como rodar

Requer **Node.js 22.13+**, que já traz o `node:sqlite` embutido. Não há dependência nativa para compilar.

```bash
npm install
cp .env.example .env        # preencha as chaves
npm run validate            # Etapa 1: testa Finnhub, Alpaca, SEC, JEV e analista
npm run dev                 # backend (127.0.0.1:8787) + interface (http://localhost:5173)
```

Para usar sem modo de desenvolvimento, rode `npm start`. Ele compila a interface e serve tudo em http://127.0.0.1:8787.

O **backend precisa continuar rodando** para coletar, decidir e executar. Fechar a aba não o interrompe. Desligar ou suspender o computador interrompe.

### Sem chaves: modo de demonstração

```bash
npm run demo                                   # simula 2 semanas com relógio acelerado → data/demo.db
DATA_MODE=mock DB_PATH=data/demo.db npm run dev
```

No modo mock, notícias, preços e "IA" são **sintéticos**, e a dashboard mostra um aviso vermelho. Serve para ver o fluxo e a contabilidade, não para avaliar a estratégia.

### Testes

```bash
npm test          # 43 testes: calendário, simulador, deduplicação, regras, IA, métricas, fluxo completo
npm run typecheck
```

## O que conferir na Etapa 1 (`npm run validate`)

O relatório vai para `data/validation-report.json`. Confira:

- **Finnhub**: quantidade de notícias, proporção com resumo, atraso da mais recente e cobertura de um ano atrás.
- **Alpaca**: barras de 1 minuto do IEX (proporção de minutos sem negociação), atraso da última barra, histórico diário ajustado, eventos corporativos e se o SIP recente está bloqueado (é o esperado no plano gratuito).
- **SEC**: formulários 8-K recentes. Exige `SEC_USER_AGENT` com nome e e-mail.
- **OpenRouter**: se `typesafe/jev-1.13` e o modelo analista existem, e com qual preço.
- **JEV**: ⚠️ **o formato exato do endpoint `POST /api/alpha/decisions` não pôde ser conferido.** O corpo enviado está em `buildJevRequest` e o parser (`parseJevResponse`, em `server/ai/jev.ts`) aceita as variações mais prováveis. O script imprime a resposta bruta: se o rótulo não for reconhecido, ajuste essas duas funções. A resposta bruta de cada classificação fica gravada no banco.
- **Analista**: `ANALYST_MODEL` vem com um valor padrão. Confira o identificador na lista de modelos da OpenRouter e escolha por qualidade e custo.

## Como a simulação evita resultados enganosos

- **Execução só depois da decisão.** A decisão é registrada primeiro. A ordem executa na abertura da **primeira barra de 1 minuto que começa depois dela**, sem escolher entre preços. Se a coleta ainda não cobre esse minuto, a ordem fica pendente.
- **Sem preço, sem execução.** Uma compra sem negociação no pregão expira e devolve o caixa reservado. A execução é marcada como aproximação (feed IEX parcial + meio spread + slippage estimados).
- **Nada retroativo.** Cada experimento tem uma rodada por pregão, dentro de uma janela de tolerância (45 min, por padrão). Se o programa estava desligado, a rodada é registrada como **perdida**, nunca refeita depois. Reiniciar não duplica análises, decisões nem ordens (há restrições `UNIQUE` no banco).
- **Saída definida na entrada.** A venda é agendada no momento da compra: N pregões depois, no mesmo horário. Notícias bearish posteriores ficam registradas, mas não mudam a saída.
- **O que se sabia na hora.** Cada análise guarda o pacote exato enviado ao modelo. Barras e notícias só entram se tinham sido buscadas antes do corte; classificações do JEV, só se feitas antes dele.
- **Contabilidade.** Os cálculos usam `decimal.js`, e o caixa é a soma de um razão (depósito, compra, venda, comissão, dividendo). As execuções usam preço bruto. Um desdobramento ajusta a quantidade uma única vez, e o histórico ajustado serve só para indicadores.
- **Referências obrigatórias**, sempre no mesmo período: mesmas ações com pesos iguais, SPY e caixa. As referências não pagam custos, o que é conservador para a estratégia.
- **Modelos e instruções fixados por experimento.** Para mudar algo, crie um experimento novo. Ele começa no próximo pregão.
- **Notícias são dados, não instruções.** Elas vão delimitadas ao modelo, a saída é validada por esquema e os ids de evento inventados são descartados.

## Limitações conhecidas

- O calendário da bolsa cobre **2024–2027** (`server/lib/calendar.ts`). Fora disso, o sistema recusa operar até a lista ser atualizada.
- Dividendos são creditados na data ex (simplificação documentada).
- A Finnhub entrega título e resumo, não o texto completo. A dashboard mostra o nível de conteúdo de cada evento.
- O agrupamento de notícias em eventos usa similaridade de títulos numa janela de 48 h. É heurístico: revise uma amostra na tela **Notícias**, cuja coluna "Revisão" mede a concordância com o JEV.
- A escala de força do sinal (0–3) é experimental.
- Com poucas operações, os resultados não permitem conclusões. A dashboard avisa quando há menos de 30 operações encerradas.

## Estrutura

```
server/
  config.ts            variáveis de ambiente e parâmetros de experimento (Zod)
  db/                  schema SQLite + wrapper (node:sqlite, transações)
  lib/                 calendário NYSE, dinheiro (Decimal), relógio injetável, HTTP com tentativas limitadas
  sources/             Finnhub, Alpaca, SEC/EDGAR, RSS de RI, CSV, mock
  news/ingest.ts       normalização, versões, relevância, deduplicação em eventos
  ai/                  OpenRouter, JEV, analista, orçamento diário/mensal, mock
  analysis/features.ts indicadores compactos (1/5/20 pregões, volatilidade, volume, mercado)
  pipeline/            coleta, classificação, análise, rodada de decisão
  sim/                 preços/cobertura, motor de ordens e contabilidade, regras de compra
  eval/                avaliação das previsões, métricas e referências
  scheduler.ts         rotinas com estado persistido
  api.ts, index.ts     API REST (apenas 127.0.0.1) + arquivos da interface
web/src/               React + Vite + Recharts (Visão geral, Notícias, Ação, Carteira, Experimentos, Configurações)
scripts/               validate-sources.ts (Etapa 1), demo-mock.ts
tests/                 Vitest
```

Exportação CSV: tela **Configurações** ou `GET /api/export/<tabela>.csv`.
