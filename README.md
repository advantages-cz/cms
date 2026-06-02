# Adaptivio CMS

Staticke GitHub CMS pro verejnou GitHub Pages aplikaci, ktera edituje private GitHub repozitar pres GitHub API. Cilem je mit maly, auditovatelny nastroj pro obsah, data a artefakty projektu Adaptivio bez vlastni databaze a bez serveroveho tajemstvi.

## Proc vlastni aplikace

Existuji dobre OSS Git CMS nastroje:

- Decap CMS umi GitHub backend a editorial workflow nad vetvemi a pull requesty.
- Pages CMS je jednoduche editacni UI nad GitHub repozitari.

Pro Adaptivio ale potrebujeme v jednom pracovnim toku jeste stav GitHub Actions, anotace failing checks, detekci commitu pridaneho automatizaci po ulozeni z CMS a preview generovanych HTML/PDF/image souboru primo z pracovni vetve. Proto je tady mala specializovana aplikace misto obecneho CMS.

## Co umi

- Pripojeni na private repo pres per-user GitHub token.
- Cilove repo je v aplikaci nastavene napevno na `advantages-cz/avds`, defaultni vetev `master`.
- Stromove prochazeni obsahu repozitare.
- Browser back/forward funguje pro navigaci mezi soubory a slozkami v CMS.
- Read-only browse workflow s preview souboru.
- Vytvoreni pracovni vetve z defaultni vetve az pri stisku Edit.
- Pokracovani ve stejne pracovni vetvi, pokud uzivatel neni na defaultni vetvi.
- Explicitni zalozeni nove pracovni vetve, kdyz o to uzivatel pozada.
- Markdown-only editace `.md` a `.mdx` souboru.
- Explicitni commit pres Contents API.
- Vytvoreni pull requestu do defaultni vetve.
- Diff vetve proti defaultni vetvi.
- Detekce zmen po poslednim CMS commitu, typicky pokud GitHub Action pushne dalsi commit.
- Stav workflow runs pro aktualni vetev.
- Volitelne nacteni check runs a check annotations pro chyby z CI, pokud token/instalace podporuje Checks API.
- Renderovane Markdown preview vcetne front matter.
- Preview HTML v sandboxovanem iframe vcetne relativnich image/SVG/CSS assetu.
- Preview PDF, SVG, obrazku a textu.

## Bezpecnostni model

Aplikace je ciste staticka. Neexistuje zadny backend, ktery by drzel secret nebo proxyoval private data. Token zustava v prohlizeci uzivatele a posila se jen na `https://api.github.com`.

Doporucena prava pro fine-grained token:

- `Metadata`: read
- `Contents`: read/write
- `Pull requests`: read/write
- `Actions`: read
- `Checks`: volitelne, jen pro detailni check runs a anotace; pokud fine-grained PAT tuhle permission nenabizi, CMS pouzije `Actions: read`.

Volitelne je mozne povolit `Actions: write`, pokud ma CMS znovu spoustet workflow runs.

Vychozi ulozeni tokenu je `sessionStorage`. Trvale ulozeni do `localStorage` je mozne, ale melo by zustat jen pro duveryhodny pocitac. Primy commit do defaultni vetve je vypnuty.

HTML preview je sandboxovane bez `allow-scripts` a bez `allow-same-origin`. Aplikace nikdy neinjektuje obsah souboru jako HTML do vlastniho DOM.

## Konfigurace

Volitelny soubor `cms.config.json` muze byt vedle `index.html`:

```json
{
  "branchPrefix": "cms/",
  "editablePathHints": ["content/", "docs/", "data/", "assets/"],
  "previewPathHints": ["dist/", "public/", "site/", "exports/"],
  "githubOAuthClientId": ""
}
```

Repozitar a defaultni vetev nejsou uzivatelsky konfigurovatelne v UI; aplikace pouziva `advantages-cz/avds` a `master`.

Vyber souboru nebo slozky si CMS uklada do URL pres `path` nebo `dir`, takze odkaz muze otevrit konkretni misto ve vetvi:

```text
https://example.github.io/adaptivio-cms/?branch=master&path=content/page.md
```

`githubOAuthClientId` je volitelne. Device flow nevyzaduje client secret, ale GitHub OAuth endpointy mohou v cistem browser kontextu narazit na CORS; fine-grained PAT je proto primarni a nejpredikovatelnejsi varianta.

## Nasazeni na GitHub Pages

Projekt nepotrebuje build krok. Workflow v `.github/workflows/pages.yml` publikuje obsah repozitare jako statickou Pages aplikaci.

V GitHub repo nastav:

1. Settings -> Pages -> Source: GitHub Actions.
2. Push do `main` nebo `master`.
3. Otevri publikovanou Pages URL.

## Lokalne

```sh
python3 -m http.server 4173
```

Potom otevri `http://localhost:4173`.

## Omezeni

- CMS nacita strom repozitare pres Git Trees API. U velmi velkych repozitaru muze GitHub vratit zkraceny strom.
- Editace je zamerne omezena na Markdown. Ostatni soubory se prohlizeji nebo vznikaji automatizaci.
- Preview ukazuje soubory commitnute do vetve. Nestahuje samostatne Actions artifacts ZIPy.
- Merge PR zustava v GitHub UI, aby ochrany vetvi a review pravidla zustaly zdrojem pravdy.

## Reference

- Decap CMS GitHub backend: https://decapcms.org/docs/github-backend/
- Decap CMS editorial workflow: https://decapcms.org/docs/editorial-workflows/
- Pages CMS docs: https://pagescms.org/docs/
- GitHub Contents API: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28
- GitHub Pull Requests API: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28
- GitHub Checks API: https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28
- GitHub Actions workflow runs API: https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2022-11-28
- GitHub compare commits API: https://docs.github.com/en/rest/commits/commits?apiVersion=2022-11-28
- GitHub OAuth device flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
