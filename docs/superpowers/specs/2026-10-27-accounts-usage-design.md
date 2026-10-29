# Account, quote e spazi di lavoro
Implementare richiesta approvata nella conversazione: due barre sotto la chat (5 ore, settimana) con percentuale residua e data/ora reset locali; account multipli aggiungibili via device-code, selezionabili, rinominabili ed eliminabili dal pannello autenticato. Quote reali via account/rateLimits/read; assenza dati dichiarata.

Due soli spazi: El e zilpio, rispettivamente /home/codex/el e /home/codex/zilpio. Cronologie Codex distinte tramite CODEX_HOME /home/codex/.El e /home/codex/.zilpio. Configurazioni condivise dalla .codex preesistente; non modificare auth, chat o configurazioni preesistenti. .codex-logins contiene esclusivamente file auth, un file per account; metadati selezione e nomi in .webui separata. Configurazioni condivise via link, auth del runtime via link al file account, sessioni e database per workspace. Importare copia dell'auth corrente senza mostrarla al browser. Non migrare/distruggere cronologie esistenti.

## Approaches
Usare un app-server per ogni browser moltiplicherebbe processi e concorrenza sulla stessa cronologia. Scelta implementativa: mantenere l'app-server unico già esistente; cambio account/workspace globale ai browser collegati, bloccato durante risposte o approvazioni pendenti. Login separato temporaneo per non interrompere account attivo. Evento runtime/changed ricarica tutti i browser dopo switch completato. Login esterno necessario effettuato dall'utente.

## Verifica
Test auth segrete mai esposte, validazione identificativi, separazione cronologie e account, default preservato, switch bloccato durante turn, quote mancanti, reset Unix secondi, UI mobile e browser. Test locali con account fittizi; non generare risposte a pagamento. Deploy dopo test, backup configurazione e verifica HTTPS.
