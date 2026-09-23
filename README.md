# Fjern PWA

Installerbar TV-fjernkontroll med et eget, bildegenerert ikonsett. Appen styrer Roku og LG webOS på lokalnettet gjennom en liten lokal bro som kjører på **samme Android-telefon**. Ingen konto, eksterne skript, skyservere eller npm-pakker.

## Installer på Android

1. Last ned `Fjern-PWA.zip` til telefonen.
2. Installer [Termux fra F-Droid](https://f-droid.org/packages/com.termux/) eller [Termux sitt GitHub-prosjekt](https://github.com/termux/termux-app). Åpne Termux.
3. Skriv følgende kommandoer, en linje om gangen:

   ```sh
   termux-setup-storage
   pkg update
   pkg install nodejs unzip
   mkdir -p ~/fjern-pwa
   unzip -o ~/storage/downloads/Fjern-PWA.zip -d ~/fjern-pwa
   cd ~/fjern-pwa
   node server.mjs
   ```

4. La Termux være åpen i bakgrunnen. Åpne **Chrome** og gå til `http://localhost:8765`.
5. I Chrome-menyen (⋮): trykk **Installer app** eller **Legg til på startskjermen**. Ikonet vises som **Fjern**.
6. Koble mobilen og TV-en til samme Wi‑Fi. I Fjern velger du **TV-er → Søk på Wi‑Fi** eller **Legg til med IP-adresse**. Godkjenn LG-paring på TV-en.

Ved neste bruk: åpne Termux, kjør `cd ~/fjern-pwa` og `node server.mjs`, og start deretter Fjern fra hjemskjermen. Hvis Android stanser Termux i bakgrunnen, må du starte broen igjen. I Androids batteriinnstillinger kan du tillate Termux å kjøre i bakgrunnen.

## Hvorfor en lokal bro?

Vanlige PWA-er kan ikke sende SSDP-søk (UDP) fra nettleseren. En PWA publisert via HTTPS får også problemer med lokale HTTP- og `ws://`-tilkoblinger til Roku og LG. Den lille Node-broen gjør TV-søk og sender kommandoer lokalt. Appen installeres fra `localhost`, som nettleseren behandler som en sikker opprinnelse for PWA-funksjoner. En ZIP med bare statiske filer på GitHub Pages vil vise grensesnittet, men **ikke kunne styre TV-en uten broen**.

## Støtte

| Enhet | Funksjon | Begrensning |
| --- | --- | --- |
| Roku TV / Roku-spiller | SSDP-søk, ECP-navigasjon, avspilling, tekst; volum/kanal/strøm der modellen støtter det | På nyere Roku OS må `Settings → System → Advanced system settings → Control by mobile apps → Enabled` være aktivert. |
| LG webOS | SSDP-søk, TV-paring, navigasjon, lyd, kanal, avspilling, tekst, strøm av | TV-en må støtte nettverksgrensesnittet på port 3000. Strøm på via lokalnettet er ikke inkludert. |

Samsung, Google TV, Sony og rene IR-TV-er støttes ikke i denne versjonen. Enkelte kommandoer kan avvises av TV-modellen eller gjeldende app på TV-en.

## Innhold

- `public/`: PWA, manifest, service worker, grafisk grensesnitt og ikoner i størrelsene 32–512 px samt maskérbare varianter.
- `server.mjs`: lokal HTTP-bro. Binder kun til `127.0.0.1:8765` og godtar bare lokal opprinnelse.
- `data/`: lokal lagring av LG-paringsnøkler. Denne mappen inneholder ingen nøkler i ZIP-en. Unngå å publisere den etter at du har paret TV-en.

## Sikkerhet og drift

Appen er laget for bruk på et privat, betrodd Wi‑Fi. Roku ECP og LGs lokale grensesnitt bruker sine egne lokale, ikke-krypterte protokoller. Broen er ikke tilgjengelig fra andre enheter på nettverket. TV-profiler lagres i telefonens nettleser; LG-nøkkelen lagres i `data/lg-keys.json` på telefonen. Hvis du nullstiller Chrome-data, kan du måtte legge til TV-ene igjen.

Det er kontrollert at filene og lokale API-kall virker i testmiljø. Faktisk TV-paring og modellspesifikke kommandoer må testes på din TV.
