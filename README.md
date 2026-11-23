# Handletur – oppsett

Handleliste-app (PWA) som finner billigste butikker i nærheten, tar hensyn til medlemskap og tilbud, og setter butikkene i kjørerekkefølge.

## Filer
- `index.html`, `manifest.json`, `sw.js`, `icon.svg` – selve appen (legges på GitHub Pages)
- `worker/worker.js` – mellomtjenesten (Cloudflare Worker) som holder API-nøklene

## 1. API-nøkler
1. **Kassalapp:** lag konto på https://kassal.app/api og generer en nøkkel (Hobby er gratis til eget bruk).
2. **Claude API (for kundeavis-tolkning):** lag nøkkel på https://console.anthropic.com. Hver kundeavis koster noen kroner å tolke, avhengig av antall sider.
3. **To passord:**
   - `APP_TOKEN`: felles passord du gir til venner og naboer som skal bruke appen.
   - `ADMIN_TOKEN`: ditt eget passord. Bare dette kan bruke kundeavis-tolkning, så andre ikke bruker opp AI-kontoen din. Du legger inn ADMIN_TOKEN i din egen app, og det gir også tilgang til alt annet.

## 2. Mellomtjenesten (Cloudflare Worker, gratis)
1. Logg inn på https://dash.cloudflare.com → Workers & Pages → Create → Worker.
2. Gi den et navn, for eksempel `handletur`, og trykk Deploy.
3. Edit code: lim inn hele `worker/worker.js` og trykk Deploy.
4. Settings → Variables and Secrets: legg inn som **Secret**
   - `KASSAL_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `APP_TOKEN`
   - `ADMIN_TOKEN`
   og eventuelt som vanlig variabel `ALLOWED_ORIGINS = https://DITTNAVN.github.io`
5. **Delingsdatabase:** Storage & Databases → D1 → Create → navn `handletur`. Åpne databasen → Console → lim inn hele `worker/schema.sql` → Execute.
6. Tilbake i Worker-en: Settings → Bindings → Add → D1 database → variabelnavn `DB` → velg `handletur`.
7. Settings → Trigger Events → Add Cron Trigger → `0 3 * * *`. Da ryddes utløpte og rapporterte tilbud bort hver natt.
8. Adressen blir `https://handletur.DITTNAVN.workers.dev`.

## Deling med nærområdet
- Når du lagrer et tilbud manuelt eller fra kundeavis, sendes det til den felles databasen sammen med et område avrundet til cirka 1 km.
- Alle med appen (og APP_TOKEN) ser delte tilbud innen valgt radius (standard 25 km) under Tilbud → «Fra nærområdet». De brukes også automatisk i beregningen av handleturen.
- 👍 bekrefter et tilbud, og ⚠ rapporterer det som feil eller utgått. Tilbud med 3 rapporter skjules og slettes om natten.
- Du kan slette dine egne tilbud, og da forsvinner de for alle. Hver telefon har en tilfeldig ID. Ingen navn eller nøyaktig posisjon lagres, bare kallenavnet hvis du har valgt å legge inn et.
- Gi venner lenken til appen og APP_TOKEN, så legger de inn Worker-adressen og tokenet under Profil → Oppsett.

## 3. Appen på GitHub Pages
1. Nytt repo, for eksempel `handletur`. Last opp `index.html`, `manifest.json`, `sw.js` og `icon.svg` i roten.
2. Settings → Pages → Deploy from branch → `main` / root.
3. Åpne `https://DITTNAVN.github.io/handletur/` på telefonen → Del → «Legg til på Hjem-skjerm».

## 4. I appen
Profil → Oppsett: slå av demo-modus, og legg inn Worker-adressen og app-tokenet. Trykk «Test tilkobling».
Slå deretter på medlemskapene dine og legg inn bonusprosent og personlige rabatter.

## Slik regner appen
- Hver vare på listen kobles til et produkt (EAN) i Kassalapp med «Finn pris». Varer som ikke er koblet, får bare pris fra tilbud.
- Tilbud matches mot varer når alle ordene i varenavnet på listen finnes i tilbudsteksten, eller når EAN er lik.
- Medlemstilbud brukes bare når medlemskapet er slått på. Bonus og personlige rabatter trekkes fra prisen.
- Appen prøver alle kombinasjoner av kjeder opp til «maks butikker». Den tar bare med en butikk til hvis du sparer minst beløpet du har satt.
- Ruten velges blant de 3 nærmeste butikkene i hver kjede, i korteste rekkefølge. Avstanden er luftlinje, mens Google Maps gir den faktiske kjøreruten.

## Kjente begrensninger
- Kassalapp-prisene for Rema 1000, Kiwi og Coop er ikke alltid oppdatert. Appen markerer priser som er eldre enn 14 dager.
- Personlige tilbud i kjedenes egne apper kan ikke hentes automatisk og må legges inn selv.
- Alle data lagres lokalt på telefonen. Bruk «Sikkerhetskopi» i Profil for å flytte dem.
