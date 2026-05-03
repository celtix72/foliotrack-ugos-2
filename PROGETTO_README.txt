Pagina DIVIDENDI, sezione Proiezione DIVIDENDI per l’anno in corso.

Input:
- Per ogni ASSET in portafoglio con posizioni aperte distinguere tra:
- Asset di tipo BOND aggiornati tramite BORSA_ITALIANA
    - determinare il dividendo annuale in base allo storico dell'anno recedente
    - creare tante date di stacco dividendo quante l'anno precedente con l'impoto di proiezione
    - se l'asset non ha dividendi storici, non creare date di stacco dividendo

- Asset di tipo Azionario aggiornati tramite Yahoo Finance
    - ricavare da Yahoo Finance il dividendo annuale previsto
    - verificare se è presente su YAhoo Finance la data di stacco del prossimo dividendo 
      e inserire l'importo come dividendo atteso per la data di stacco. 
    - se l'asset non ha dividendi storici, non creare date di stacco dividendo

- Consentire l'inserimento di una entry manuale per i dividendi attesi
    - Inserire Ticker tra quelli presenti in portafoglio
    - Inserire Data di stacco dividendo
    - Inserire Importo dividendo
    - Inserire Importo totale dividendo (importo dividendo * numero azioni)

Output da rendere comaptibile sia per GUI Fixed che per GUI Mobile:

- Crea 3 indicatori che forniscano i dati totali di:
    - Totale dividendi attesi per l'anno in corso
    - Totale dividenti già maturati per l'anno in corso
    - Totale dividendi rimanenti per l'anno in corso

- Crea un grafico a colonne che mostri i dividendi attesi per ogni mese dell'anno in corso
    - Asse X: Mesi dell'anno
    - Asse Y: Totale dividendi attesi per il mese
    - Colore delle colonne: Cyano se il dividendo è atteso, Verde se il dividendo è già stato maturato
    - Sopra alle colonne indicare il totale dei dividendi attesi per il mese
    - Sotto alle colonne i ticker degli asset che hanno dividendi attesi per il mese

- Per ogni ASSET in portafoglio con posizioni aperte creare una lista con righe con le seguenti informazioni:
    - Nome Asset
    - Data di stacco dividendo ( Aggiungere un TAG che indichi se il dividendo è registrato,
                                  previsto ( letto da YF ) o proiettato in base all'anno precedente )
    - Importo dividendo
    - Importo totale dividendo (importo dividendo * numero azioni)
    - Totale dividendi attesi per l'anno in corso
    - Percentuale DIVIDENDO Annuo previsto ( dividendo annuale / prezzo corrente )
    

    
