const {onRequest} = require("firebase-functions/v2/https");
const {onSchedule} = require("firebase-functions/v2/scheduler");

const admin = require("firebase-admin");
admin.initializeApp();

// 🔑 HER ER API-NØKKELEN DIN! 
// Du kan bytte denne til "SuperHemmelig123" eller hva du vil.
// Det er denne du gir til de andre i Discord-gruppen.
const API_KEY = "abc123"; 

exports.api = onRequest({ region: "europe-west1", invoker: 'public' }, async (req, res) => {
    
    // --- NYTT: CORS-FIKS ---
    // Dette forteller nettleseren at API-et er åpent for alle ("*")
    // og tillater at folk sender med den hemmelige "X-API-Key" headeren.
    res.set('Access-Control-Allow-Origin', '*'); 
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    // Før en nettleser gjør et API-kall, sender den et usynlig "OPTIONS" (preflight) 
    // anrop for å sjekke om det er trygt. Vi svarer "JA" (204).
    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }
    // -----------------------

    // 1. SIKKERHETSSJEKK: Kun GET-metode tillatt
    if (req.method !== 'GET') {
        return res.status(405).json({ error: "Kun GET-forespørsler er tillatt" });
    }

    // 2. SIKKERHETSSJEKK: Sjekk API-nøkkelen i headeren
    const providedKey = req.headers['x-api-key'];
    if (providedKey !== API_KEY) {
        return res.status(401).json({ error: "Uautorisert. Ugyldig API-nøkkel." });
    }

    // 3. HENT PARAMETERE: from og to (forventer Unix timestamps)
    const fromTs = parseInt(req.query.from);
    const toTs = parseInt(req.query.to) || Date.now();

    if (!fromTs || isNaN(fromTs)) {
        return res.status(400).json({ error: "Mangler parameter: '?from=' (må være Unix timestamp)" });
    }

    try {
        const db = admin.database();
        const snapshot = await db.ref('alle_oppdateringer')
            .orderByChild('timestamp')
            .startAt(fromTs)
            .endAt(toTs)
            .once('value');

        const data = snapshot.val();
        let pricesList = [];

        if (data) {
            Object.values(data).forEach(update => {
                const stId = update.station_id || "ukjent_id";
                const isoTime = new Date(update.timestamp).toISOString();

                const addPriceObj = (type, priceString) => {
                    if (priceString && priceString !== "--") {
                        const priceNum = parseFloat(priceString.replace(',', '.'));
                        pricesList.push({
                            station_id: stId,
                            fuel_type: type,
                            price: priceNum,
                            updated: isoTime
                        });
                    }
                };

                addPriceObj("diesel", update.diesel);
                addPriceObj("bensin95", update.bensin);
                addPriceObj("bensin98", update.bensin98);
                addPriceObj("farget_diesel", update.fd);
            });
        }

        res.status(200).json({ prices: pricesList });

    } catch (error) {
        console.error("Feil ved uthenting av API data:", error);
        res.status(500).json({ error: "Intern serverfeil" });
    }
});

// --- NYTT: Proxy-funksjon for å hente bildata fra Statens Vegvesen ---
// Denne funksjonen fungerer som en mellomstasjon for å unngå CORS-feil i nettleseren.
exports.getCarData = onRequest({ region: "europe-west1", invoker: 'public' }, async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(204).send('');
    }

    const regnr = req.query.regnr;
    if (!regnr) {
        return res.status(400).json({ error: "Mangler 'regnr' parameter." });
    }

    // Tilbake til din opprinnelige (og riktige!) URL
    const apiUrl = `https://akfell-datautlevering.atlas.vegvesen.no/enkeltoppslag/kjoretoydata?kjennemerke=${regnr}`;
    
    // Pass på at denne nøkkelen er den ferske du lagde sist!
    const apiKey = 'f499435c-82a2-46dc-a9f8-29ab15538019'; 

    try {
        const response = await fetch(apiUrl, {
            headers: {
                // MAGIEN: Apikey med LITEN k!
                'SVV-Authorization': `Apikey ${apiKey}`,
                'Accept': 'application/json',
                'User-Agent': 'drivstoffnorge.no'
            }
        });

        const responseBody = await response.text();

        console.log(`[getCarData] Vegvesen Response Status: ${response.status}`);
        if (!response.ok) {
            console.error(`[getCarData] Vegvesen Response Body (Error):`, responseBody);
        }

        res.set('Content-Type', 'application/json');
        
        // Vi returnerer statuskoden slik vi gjorde da det fungerte, 
        // nå som k-en er rettet opp!
        res.status(response.status).send(responseBody);

    } catch (error) {
        console.error('Proxy-funksjon for bildata feilet:', error);
        res.status(500).json({ error: "Intern serverfeil i proxy-funksjonen." });
    }
});

// --- NYTT: Hjelpefunksjoner for de-duplisering, kopiert fra appen ---
function regnUtAvstand(l1, o1, l2, o2) {
    if (!l1 || !o1 || !l2 || !o2) return Infinity;
    const R = 6371;
    const dL = (l2 - l1) * Math.PI / 180;
    const dO = (o2 - o1) * Math.PI / 180;
    const a = Math.sin(dL / 2) ** 2 + Math.cos(l1 * Math.PI / 180) * Math.cos(l2 * Math.PI / 180) * Math.sin(dO / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)); // avstand i km
}

function formaterStasjonsNavn(rawNavn) {
    if (!rawNavn) return { sted: "Ukjent", kjede: "Ukjent" };
    let n = rawNavn.replace(/\s*\(?automat\)?(?!\s*1)\s*/gi, ' ')
                   .replace(/\s*\(?truck\)?\s*/gi, ' ')
                   .replace(/\s*\(?express\)?\s*/gi, ' ')
                   .trim();
    
    let kjede = "Ukjent";
    let nLower = n.toLowerCase();
    
    if (nLower.includes("circle k")) kjede = "Circle K";
    else if (nLower.includes("yx")) kjede = "YX";
    else if (nLower.includes("uno-x") || nLower.includes("unox") || nLower.includes("uno x")) kjede = "Uno-X";
    else if (nLower.includes("esso")) kjede = "Esso";
    else if (nLower.includes("st1")) kjede = "St1";
    else if (nLower.includes("best")) kjede = "Best";
    else if (nLower.includes("bunker")) kjede = "Bunker Oil";
    else if (nLower.includes("tanken")) kjede = "Tanken";
    else if (nLower.includes("driv")) kjede = "Driv";
    else if (nLower.includes("automat 1") || nLower.includes("automat1")) kjede = "Automat 1";
    else if (nLower.includes("haltbakk")) kjede = "Haltbakk";
    else if (nLower.includes("joker")) kjede = "Joker";
    else if (nLower.includes("lpg")) kjede = "LPG";
    else if (nLower.includes("cng")) kjede = "CNG";
    else if (nLower.includes("oljeleverandør") || nLower.includes("olje leverandør")) kjede = "Oljeleverandøren";
    else if (nLower.includes("olje")) kjede = "Olje";
    
    let sted = n;
    if (kjede !== "Ukjent") {
        if (kjede === "Uno-X") { sted = sted.replace(/uno\s*-?\s*x/ig, ''); } 
        else if (kjede === "Oljeleverandøren") { sted = sted.replace(/olje\s*leverandør(en)?/ig, ''); } 
        else {
            let reg = new RegExp(kjede.replace("-", "\\-?").replace(" ", "\\s*"), "ig");
            sted = sted.replace(reg, '');
        }
        sted = sted.trim();
    }
    
    sted = sted.replace(/^[-,\s]+|[-,\s]+$/g, '');
    if (!sted || sted === "") sted = kjede !== "Ukjent" ? kjede : n;
    sted = sted.charAt(0).toUpperCase() + sted.slice(1);
    
    return { sted: sted, kjede: kjede };
}

// --- NYTT: Automatisk import av priser ---
// Denne funksjonen kjører automatisk hver 12. time.
// Du kan endre 'every 12 hours' til f.eks. 'every 6 hours' eller '0 9 * * *' for å kjøre kl 09:00 hver dag.
exports.importerDrivstoffpriserDataAutomatisk = onSchedule({ schedule: "every 12 hours", region: "europe-west1" }, async (event) => {
    console.log('Starter automatisk import av drivstoffpriser...');

    const adminUid = 'Y9G9KDuAGgW9qWzMMWbIj7yyHwR2'; // Admin-UID fra appen
    const db = admin.database();

    try {
        // 1. Hent stasjoner og priser fra eksternt repo
        const [stasjonerResponse, priserResponse] = await Promise.all([
            fetch('https://drivstoffpriser.github.io/Drivstoffpriser-App/data/stations.json'),
            fetch('https://drivstoffpriser.github.io/Drivstoffpriser-App/data/prices.json')
        ]);

        const stasjonerData = await stasjonerResponse.json();
        const priserData = await priserResponse.json();

        const stasjoner = stasjonerData.stations || [];
        const priser = priserData.prices || [];
        
        const stasjonMap = new Map(stasjoner.map((stasjon) => [String(stasjon.id), stasjon]));
        let oppdatertePriser = 0;
        let nyeStasjoner = 0;

        // NYTT: Hent alle eksisterende stasjoner FØRST for å kunne sjekke mot dem.
        const alleEksisterendeStasjonerRef = db.ref('egne_stasjoner');
        const eksisterendeSnapshot = await alleEksisterendeStasjonerRef.once('value');
        const alleEksisterendeStasjoner = Object.values(eksisterendeSnapshot.val() || {});
        const DISTANCE_THRESHOLD_KM = 0.05; // 50 meter

        // Importer stasjoner som ikke finnes i 'egne_stasjoner'
        for (const stasjon of stasjoner) {
            const safeId = String(stasjon.id).replace(/[\.\#\$\[\]\/]/g, "_");
            const stasjonRef = db.ref('egne_stasjoner/' + safeId);
            const snapshot = await stasjonRef.once('value');
            if (snapshot.exists()) continue;

            const nyStasjonNavnFormatert = formaterStasjonsNavn(stasjon.name || "");
            const nyStasjonLat = Number(stasjon.latitude);
            const nyStasjonLon = Number(stasjon.longitude);

            let erDuplikat = false;
            for (const eksisterende of alleEksisterendeStasjoner) {
                const avstand = regnUtAvstand(nyStasjonLat, nyStasjonLon, eksisterende.lat, eksisterende.lon);
                if (avstand < DISTANCE_THRESHOLD_KM) { erDuplikat = true; break; }

                const eksisterendeNavnFormatert = formaterStasjonsNavn(eksisterende.navn || "");
                if (nyStasjonNavnFormatert.sted.toLowerCase() === eksisterendeNavnFormatert.sted.toLowerCase() &&
                    nyStasjonNavnFormatert.kjede === eksisterendeNavnFormatert.kjede) {
                    erDuplikat = true;
                    break;
                }
            }

            if (!erDuplikat) {
                const nyStasjonData = { lat: nyStasjonLat || 0, lon: nyStasjonLon || 0, navn: String(stasjon.name || 'Ukjent'), kjede: String(stasjon.brand || 'Ukjent'), id: String(stasjon.id) };
                await stasjonRef.set(nyStasjonData);
                nyeStasjoner++;
                alleEksisterendeStasjoner.push(nyStasjonData);
            }
        }

        // 2. Gå gjennom hver pris og oppdater databasen
        for (const pris of priser) {
            const stationKey = pris.stationId ?? pris.station_id ?? pris.id;
            if (!stationKey) continue;

            const safeId = String(stationKey).replace(/[\.\#\$\[\]\/]/g, "_");
            const prisRef = db.ref('priser/' + safeId);
            const snapshot = await prisRef.once('value');
            const eksisterende = snapshot.val() || {};
            const stasjon = stasjonMap.get(String(stationKey));

            if (eksisterende && Object.keys(eksisterende).length > 0 && !eksisterende.is_import) {
                const alderMs = Date.now() - (eksisterende.timestamp || 0);
                if (alderMs <= (24 * 60 * 60 * 1000)) {
                    continue; 
                }
            }

            const fuelType = pris.fuelType === 'petrol95' ? 'bensin' : pris.fuelType === 'petrol98' ? 'bensin98' : pris.fuelType === 'diesel' ? 'diesel' : '';
            if (!fuelType) continue;

            const hentStreng = (verdi) => {
                if (verdi === undefined || verdi === null || verdi === '') return '--';
                const num = parseFloat(String(verdi).replace(',', '.'));
                return isNaN(num) ? '--' : num.toFixed(2).replace('.', ',');
            };

            const nyPrisObjekt = { ...eksisterende, station_id: safeId, timestamp: Date.now(), user: 'Import', uid: adminUid, verified: false, is_import: true, lat: Number(stasjon?.latitude) || eksisterende.lat || 0, lon: Number(stasjon?.longitude) || eksisterende.lon || 0, land: 'NO', navn: String(stasjon?.name || eksisterende.navn || 'Ukjent') };
            nyPrisObjekt[fuelType] = hentStreng(pris.price ?? pris.value ?? pris.price_value);
            
            await prisRef.set(nyPrisObjekt);
            oppdatertePriser++;
        }
        
        console.log(`Automatisk import fullført! ${nyeStasjoner} nye stasjoner, ${oppdatertePriser} oppdaterte priser.`);
        return null;

    } catch (error) {
        console.error("Feil under automatisk import:", error);
        return null;
    }
});

// NYTT: Beregner nasjonalt snitt for hva brukere faktisk betaler
exports.beregnNasjonaltSnittBetalt = onSchedule({ schedule: "every 12 hours", region: "europe-west1" }, async (event) => {
    console.log('Starter beregning av nasjonalt snitt for betalt drivstoffpris...');
    const db = admin.database();
    const fyllingerRef = db.ref('fyllinger');

    // Hent fyllinger fra de siste 30 dagene
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    try {
        const snapshot = await fyllingerRef.orderByChild('timestamp').startAt(thirtyDaysAgo).once('value');
        const fyllinger = snapshot.val();

        if (!fyllinger) {
            console.log('Ingen fyllinger funnet de siste 30 dagene. Avslutter beregning.');
            return null;
        }

        let totalPengerBensin = 0;
        let totalLiterBensin = 0;
        let totalPengerDiesel = 0;
        let totalLiterDiesel = 0;

        Object.values(fyllinger).forEach(fylling => {
            if (fylling.pris && fylling.liter > 0) {
                const kostnad = fylling.pris * fylling.liter;
                if (fylling.drivstoff && fylling.drivstoff.toLowerCase().includes('bensin')) { // Inkluderer Bensin og Bensin98
                    totalPengerBensin += kostnad;
                    totalLiterBensin += fylling.liter;
                } else if (fylling.drivstoff && fylling.drivstoff.toLowerCase().includes('diesel')) { // Inkluderer Diesel og Farget Diesel
                    totalPengerDiesel += kostnad;
                    totalLiterDiesel += fylling.liter;
                }
            }
        });

        const snittprisBensin = totalLiterBensin > 0 ? (totalPengerBensin / totalLiterBensin) : 0;
        const snittprisDiesel = totalLiterDiesel > 0 ? (totalPengerDiesel / totalLiterDiesel) : 0;

        const statistikkRef = db.ref('statistikk/nasjonaltSnittBetalt');
        await statistikkRef.set({ bensin: snittprisBensin, diesel: snittprisDiesel, sistOppdatert: admin.database.ServerValue.TIMESTAMP });

        console.log(`Beregning fullført. Snittpris bensin: ${snittprisBensin.toFixed(2)}, diesel: ${snittprisDiesel.toFixed(2)}`);
        return null;
    } catch (error) {
        console.error("Feil under beregning av nasjonalt snitt for betalt pris:", error);
        return null;
    }
});

// NYTT: Beregner nasjonalt snitt for hva brukere faktisk betaler
exports.beregnNasjonaltSnittBetalt = onSchedule({ schedule: "every 12 hours", region: "europe-west1" }, async (event) => {
    console.log('Starter beregning av nasjonalt snitt for betalt drivstoffpris...');
    const db = admin.database();
    const fyllingerRef = db.ref('fyllinger');

    // Hent fyllinger fra de siste 30 dagene
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    try {
        const snapshot = await fyllingerRef.orderByChild('timestamp').startAt(thirtyDaysAgo).once('value');
        const fyllinger = snapshot.val();

        if (!fyllinger) {
            console.log('Ingen fyllinger funnet de siste 30 dagene. Avslutter beregning.');
            return null;
        }

        let totalPengerBensin = 0;
        let totalLiterBensin = 0;
        let totalPengerDiesel = 0;
        let totalLiterDiesel = 0;

        Object.values(fyllinger).forEach(fylling => {
            if (fylling.pris && fylling.liter > 0) {
                const kostnad = fylling.pris * fylling.liter;
                if (fylling.drivstoff && fylling.drivstoff.toLowerCase().includes('bensin')) { // Inkluderer Bensin og Bensin98
                    totalPengerBensin += kostnad;
                    totalLiterBensin += fylling.liter;
                } else if (fylling.drivstoff && fylling.drivstoff.toLowerCase().includes('diesel')) { // Inkluderer Diesel og Farget Diesel
                    totalPengerDiesel += kostnad;
                    totalLiterDiesel += fylling.liter;
                }
            }
        });

        const snittprisBensin = totalLiterBensin > 0 ? (totalPengerBensin / totalLiterBensin) : 0;
        const snittprisDiesel = totalLiterDiesel > 0 ? (totalPengerDiesel / totalLiterDiesel) : 0;

        const statistikkRef = db.ref('statistikk/nasjonaltSnittBetalt');
        await statistikkRef.set({ bensin: snittprisBensin, diesel: snittprisDiesel, sistOppdatert: admin.database.ServerValue.TIMESTAMP });

        console.log(`Beregning fullført. Snittpris bensin: ${snittprisBensin.toFixed(2)}, diesel: ${snittprisDiesel.toFixed(2)}`);
        return null;
    } catch (error) {
        console.error("Feil under beregning av nasjonalt snitt for betalt pris:", error);
        return null;
    }
});