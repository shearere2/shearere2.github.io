// ====== CONFIG ======
const ORS_API_KEY = "eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJjZjFhYzQzZjdhOTRmNWQ5ZTYyODkyYzVhYWZhYTRmIiwiaCI6Im11cm11cjY0In0="; // <- replace this with your real key
// ==============================
// RoadShear NPS Wizard MVP (v0.7)
// - Step 1: START + trip budget → destination park search using a simple GIS buffer
// - Step 2: stop selection using NPS POIs + Census Places (and optional free OSM amenities)
//
// FIXES in this version:
// 1) Destination search now does: compute radius → buffer around START → show all park centroids within radius.
// 2) Robust ArcGIS pagination (prevents “0 parks” due to capped result sets).
// 3) "Set START" will NOT geocode unless the user actually typed something.
//    - If the box is empty, it shows "Enter a starting location" (no random defaults like Start, Louisiana).
// 4) Start marker label is now "Start" (not SHOUTING), but still visually distinctive.
// ==============================


// ---------- Fixed speed ----------
const MPH = 55;

// ---------- ArcGIS layer endpoints ----------
const LAYER_POI     = "https://services7.arcgis.com/N5yuH1iBWm1AGZoK/arcgis/rest/services/RoadShear_Version_0_1_WFL1/FeatureServer/1";
const LAYER_PLACES  = "https://services7.arcgis.com/N5yuH1iBWm1AGZoK/arcgis/rest/services/RoadShear_Version_0_1_WFL1/FeatureServer/2";
const LAYER_PARKS   = "https://services7.arcgis.com/N5yuH1iBWm1AGZoK/arcgis/rest/services/NPS_Boundaries/FeatureServer/0";

// ---------- UI elements ----------
const originInput = document.getElementById("origin");
const originError = document.getElementById("origin-error");

const tripDaysInput = document.getElementById("trip-days");
const hoursPerDayInput = document.getElementById("hours-per-day");
const stopFreqInput = document.getElementById("stop-frequency");
const daysAtDestGroup = document.getElementById("days-at-destination-group");
const daysAtDestInput = document.getElementById("days-at-destination");

const vibeGroup = document.getElementById("vibe-group");

const geocodeStartBtn = document.getElementById("geocode-start");
const findDestinationsBtn = document.getElementById("find-destinations");
const setDestinationBtn = document.getElementById("set-destination");

const destinationPreview = document.getElementById("destination-preview");
const destTitle = document.getElementById("dest-title");
const destMeta = document.getElementById("dest-meta");
const confirmDestinationBtn = document.getElementById("confirm-destination");
const clearDestinationBtn = document.getElementById("clear-destination");

const step1 = document.getElementById("step-1");
const step2 = document.getElementById("step-2");
const stepIndicator1 = document.getElementById("step-indicator-1");
const stepIndicator2 = document.getElementById("step-indicator-2");

const step2Summary = document.getElementById("step2-summary");
const modifyOriginDestBtn = document.getElementById("modify-origin-dest");
const autoPickStopsBtn = document.getElementById("auto-pick-stops");

const stopPreview = document.getElementById("stop-preview");
const stopTitle = document.getElementById("stop-title");
const stopMeta = document.getElementById("stop-meta");
const addStopBtn = document.getElementById("add-stop");
const closeStopPreviewBtn = document.getElementById("close-stop-preview");

const openGoogleBtn = document.getElementById("open-google");
const resetBtn = document.getElementById("reset");

const itineraryContainer = document.getElementById("itinerary-container");
const summarySubtitle = document.getElementById("summary-subtitle");
const summaryPills = document.getElementById("summary-pills");
const mapStatus = document.getElementById("map-status");

const toggleRoundtrip = document.getElementById("toggle-roundtrip");
const toggleOneway = document.getElementById("toggle-oneway");
const toggleOsm = document.getElementById("toggle-osm");

// ---------- Map ----------
const map = L.map("map").setView([39.5, -98.35], 5);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

// ---------- State ----------
let selectedVibe = "scenic";
let isOneWay = false;
let useOSM = false;

let start = null; // {lat,lng,label} (6 decimals)
let startMarker = null;

let destination = null; // {unitcode, unitname, lat, lng, distMiles}
let destinationMarker = null;

let destinationMarkers = [];
let destinationBufferCircle = null;

let step = 1;

// stop selection state
let candidatePool = [];          // all possible stops loaded (POIs + Places + optional OSM)
let candidateMarkers = [];       // map markers for candidates (filtered)
let selectedStopCandidate = null; // candidate object currently previewed
let selectedStops = [];          // user's chosen stop sequence

let googleMapsUrl = null;

// ---------- Marker icons ----------
const startIcon = L.divIcon({
  className: "start-marker",
  html: "Start",
  iconSize: [56, 24],
  iconAnchor: [28, 24],
});

function setStatus(msg) { mapStatus.textContent = msg; }
function fmt6(n) { return Number(n).toFixed(6); }
function milesToKm(mi) { return mi * 1.609344; }

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function safeProp(props, ...keys) {
  for (const k of keys) if (props && props[k] != null && props[k] !== "") return props[k];
  return null;
}

function clearMarkers(arr) {
  arr.forEach(m => { try { map.removeLayer(m); } catch {} });
  arr.length = 0;
}

function lockStep1Inputs(locked) {
  const inputs = [
    originInput, tripDaysInput, hoursPerDayInput, stopFreqInput, daysAtDestInput
  ];
  inputs.forEach(el => el.disabled = locked);

  toggleRoundtrip.disabled = locked;
  toggleOneway.disabled = locked;
  toggleOsm.disabled = locked;

  document.querySelectorAll(".pill-radio").forEach(p => p.style.pointerEvents = locked ? "none" : "auto");

  geocodeStartBtn.disabled = locked;
  findDestinationsBtn.disabled = locked;
}

function goToStep(newStep) {
  step = newStep;
  if (step === 1) {
    step1.style.display = "block";
    step2.style.display = "none";
    stepIndicator1.classList.add("active");
    stepIndicator2.classList.remove("active");
    summarySubtitle.textContent = "Step 1: Set Start, then search/select a destination park.";
    setStatus("Step 1: Click map or type an address and press Set Start.");
  } else {
    step1.style.display = "none";
    step2.style.display = "block";
    stepIndicator1.classList.remove("active");
    stepIndicator2.classList.add("active");
    summarySubtitle.textContent = "Step 2: Click stop markers to preview and add them to your itinerary.";
    setStatus("Step 2: Click candidates to preview, then add stops.");
  }
}

// ---------- Trip budget logic ----------
function computeBudgetMiles() {
  const days = Math.max(1, parseFloat(tripDaysInput.value || "1"));
  const hoursPerDay = Math.max(1, parseFloat(hoursPerDayInput.value || "1"));
  const totalMiles = days * hoursPerDay * MPH;

  let daysAtDest = 0;
  if (!isOneWay) {
    daysAtDest = Math.max(0, parseFloat(daysAtDestInput.value || "0"));
    if (daysAtDest > days - 1) daysAtDest = Math.max(0, days - 1);
  }

  const travelDays = isOneWay ? days : Math.max(1, days - daysAtDest);

  // Outbound travel days: for round-trip ~half travel-days; for one-way full travel-days
  const outboundDays = isOneWay ? travelDays : Math.max(1, Math.round(travelDays / 2));
  const outboundMiles = outboundDays * hoursPerDay * MPH;

  return { days, hoursPerDay, daysAtDest, travelDays, outboundDays, totalMiles, outboundMiles };
}

// ---------- Vibe mapping for POIs ----------
function poiWhereForVibe(vibe) {
  switch (vibe) {
    case "scenic":
      return "UPPER(POITYPE) LIKE '%OVERLOOK%' OR UPPER(POITYPE) LIKE '%VIEW%' OR UPPER(POITYPE) LIKE '%SCENIC%'";
    case "parks":
      return "UPPER(POITYPE) LIKE '%VISITOR%' OR UPPER(POITYPE) LIKE '%CENTER%' OR UPPER(POITYPE) LIKE '%MUSEUM%'";
    case "hiking":
      return "UPPER(POITYPE) LIKE '%TRAIL%'";
    case "towns":
      return "1=1";
    case "mixed":
    default:
      return "1=1";
  }
}

// ---------- ArcGIS REST Query helpers ----------
async function arcgisQueryGeoJSON(layerUrl, params) {
  const url = new URL(layerUrl + "/query");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ArcGIS query failed: ${res.status}`);
  return await res.json();
}

async function arcgisQueryJSON(layerUrl, params) {
  const url = new URL(layerUrl + "/query");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ArcGIS query failed: ${res.status}`);
  return await res.json();
}

// Pull ALL features with pagination (works around ArcGIS transfer limits)
async function arcgisQueryAllJSON(layerUrl, baseParams) {
  const allFeatures = [];
  let resultOffset = 0;
  const pageSize = 2000;

  while (true) {
    const params = {
      ...baseParams,
      resultRecordCount: String(pageSize),
      resultOffset: String(resultOffset)
    };

    const data = await arcgisQueryJSON(layerUrl, params);
    const feats = data?.features || [];
    allFeatures.push(...feats);

    if (data?.exceededTransferLimit === true && feats.length > 0) {
      resultOffset += feats.length;
      continue;
    }
    break;
  }

  return allFeatures;
}

// ---------- ORS geocode ----------
async function orsGeocode(text) {
  const url = new URL("https://api.openrouteservice.org/geocode/search");
  url.searchParams.set("api_key", ORS_API_KEY);
  url.searchParams.set("text", text);
  url.searchParams.set("size", "1");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`ORS geocode failed: ${res.status}`);
  const data = await res.json();
  if (!data?.features?.length) return null;
  const [lon, lat] = data.features[0].geometry.coordinates;
  const label = data.features[0].properties?.label || text;
  return { lat: +lat, lng: +lon, label };
}

// ---------- START handling ----------
map.on("click", (e) => {
  setStart({ lat: e.latlng.lat, lng: e.latlng.lng, label: `Start @ ${fmt6(e.latlng.lat)}, ${fmt6(e.latlng.lng)}` });
});

function setStart(s) {
  start = { lat: +fmt6(s.lat), lng: +fmt6(s.lng), label: s.label };

  if (startMarker) map.removeLayer(startMarker);
  startMarker = L.marker([start.lat, start.lng], { icon: startIcon }).addTo(map);

  // Set input text to something sane but not "random"
  originInput.value = s.label;

  setStatus("Start set. Now click “Find destination parks”.");

  clearDestinationSelection(true);
  resetStopsOnly();
}

// IMPORTANT: Only geocode if the user typed something.
// If input is empty, show error and do nothing.
geocodeStartBtn.addEventListener("click", async () => {
  try {
    originError.style.display = "none";

    const q = originInput.value.trim();

    if (!q) {
      originError.textContent = "Enter a starting location (or click the map).";
      originError.style.display = "block";
      setStatus("No start typed. Enter a start or click the map.");
      return;
    }

    if (!ORS_API_KEY || ORS_API_KEY.includes("YOUR_ORS")) {
      originError.textContent = "Add your ORS API key in app.js.";
      originError.style.display = "block";
      setStatus("Missing ORS key.");
      return;
    }

    setStatus("Searching start location (ORS geocode)...");
    const r = await orsGeocode(q);

    if (!r) {
      originError.textContent = "No results found. Try a more specific address.";
      originError.style.display = "block";
      setStatus("Start search failed.");
      return;
    }

    setStart({ ...r, label: r.label });
    map.setView([r.lat, r.lng], 9);
  } catch (err) {
    console.error(err);
    originError.textContent = "Error during start search. Check ORS key / console.";
    originError.style.display = "block";
    setStatus("Start search error.");
  }
});

// ---------- Trip type toggles ----------
toggleRoundtrip.addEventListener("click", () => {
  isOneWay = false;
  toggleRoundtrip.classList.add("active");
  toggleOneway.classList.remove("active");
  daysAtDestGroup.style.display = "block";
  clearDestinationSelection(false);
  setStatus("Round trip selected. Destination distance uses outbound travel budget.");
});

toggleOneway.addEventListener("click", () => {
  isOneWay = true;
  toggleOneway.classList.add("active");
  toggleRoundtrip.classList.remove("active");
  daysAtDestGroup.style.display = "none";
  clearDestinationSelection(false);
  setStatus("One-way selected. Destination distance uses full travel budget.");
});

// Optional OSM
toggleOsm.addEventListener("click", () => {
  useOSM = !useOSM;
  toggleOsm.textContent = useOSM ? "OSM amenities: ON" : "OSM amenities: OFF";
  toggleOsm.classList.toggle("active", useOSM);
});

// ---------- Vibe selection ----------
vibeGroup.addEventListener("click", (e) => {
  const pill = e.target.closest(".pill-radio");
  if (!pill) return;
  document.querySelectorAll(".pill-radio").forEach(p => p.classList.remove("active"));
  pill.classList.add("active");
  selectedVibe = pill.dataset.value;
  setStatus(`Vibe set: ${selectedVibe}.`);
});

// ---------- Destination search (SIMPLE BUFFER) ----------
findDestinationsBtn.addEventListener("click", async () => {
  if (!start) { setStatus("Set Start first (click map or use Set Start)."); return; }

  const budget = computeBudgetMiles();

  // GIS buffer distance: use outbound miles as the radius to search within
  const searchRadiusMiles = Math.max(50, budget.outboundMiles);

  try {
    setStatus(`Searching parks within ${searchRadiusMiles.toFixed(0)} miles of Start (buffer)…`);

    clearDestinationSelection(true);

    // Draw/update buffer circle on map
    if (destinationBufferCircle) {
      try { map.removeLayer(destinationBufferCircle); } catch {}
      destinationBufferCircle = null;
    }
    destinationBufferCircle = L.circle([start.lat, start.lng], {
      radius: milesToKm(searchRadiusMiles) * 1000,
      weight: 2,
      fillOpacity: 0.05
    }).addTo(map);

    // Load ALL parks as centroids (paginated), then filter within radius
    const allParks = await arcgisQueryAllJSON(LAYER_PARKS, {
      f: "json",
      where: "1=1",
      outFields: "UNITCODE,UNITNAME",
      returnGeometry: "false",
      returnCentroid: "true"
    });

    if (!allParks.length) {
      setStatus("No parks returned from the parks service. Check console.");
      console.log("allParks:", allParks);
      return;
    }

    const within = [];
    for (const f of allParks) {
      const props = f.attributes || {};
      const unitname = safeProp(props, "UNITNAME") || "NPS Park";
      const unitcode = safeProp(props, "UNITCODE") || "";

      const c = f.centroid;
      if (!c || c.x == null || c.y == null) continue;

      const lng = +fmt6(c.x);
      const lat = +fmt6(c.y);

      const dMiles = turf.distance(
        turf.point([start.lng, start.lat]),
        turf.point([lng, lat]),
        { units: "miles" }
      );

      if (dMiles <= searchRadiusMiles) {
        within.push({ unitname, unitcode, lat, lng, distMiles: dMiles });
      }
    }

    if (!within.length) {
      setStatus(`No parks found within ${searchRadiusMiles.toFixed(0)} miles. Check console for debug.`);
      console.log("Debug:", { searchRadiusMiles, budget, start, allParksCount: allParks.length });
      return;
    }

    within.sort((a, b) => a.distMiles - b.distMiles);

    // For performance: show up to 250 markers, but report total count found.
    const displayMax = 250;
    const toShow = within.slice(0, displayMax);

    toShow.forEach((p) => {
      const m = L.circleMarker([p.lat, p.lng], {
        radius: 7,
        weight: 2,
        fillOpacity: 0.6
      }).addTo(map);

      m.bindPopup(
        `<b>${escapeHtml(p.unitname)}</b><br/>` +
        `${p.unitcode ? `Code: ${escapeHtml(p.unitcode)}<br/>` : ""}` +
        `Distance: ${p.distMiles.toFixed(0)} mi<br/><em>Click to preview</em>`
      );

      m.on("click", () => previewDestination(p));
      destinationMarkers.push(m);
    });

    const group = L.featureGroup([startMarker, destinationBufferCircle, ...destinationMarkers].filter(Boolean));
    map.fitBounds(group.getBounds().pad(0.2));

    setStatus(`Found ${within.length} parks within buffer. Showing ${toShow.length}${within.length > displayMax ? " (capped for performance)" : ""}. Click one to preview.`);
  } catch (err) {
    console.error(err);
    setStatus("Destination buffer search failed. Check console.");
  }
});

// Preview destination from centroid object {unitname, unitcode, lat, lng, distMiles}
function previewDestination(p) {
  destinationPreview.style.display = "block";
  destTitle.textContent = p.unitname;
  destMeta.innerHTML =
    `${p.unitcode ? `<b>${escapeHtml(p.unitcode)}</b><br/>` : ""}` +
    `Centroid: ${fmt6(p.lat)}, ${fmt6(p.lng)}<br/>` +
    `Straight-line from Start: <b>${p.distMiles.toFixed(0)} miles</b>`;

  setDestinationBtn.disabled = false;
  confirmDestinationBtn.disabled = false;

  destination = { ...p };

  if (destinationMarker) map.removeLayer(destinationMarker);
  destinationMarker = L.marker([p.lat, p.lng]).addTo(map);
  destinationMarker.bindPopup(`<b>${escapeHtml(p.unitname)}</b><br/>Selected destination (preview)`).openPopup();
}

// Both buttons do same thing
setDestinationBtn.addEventListener("click", () => confirmDestination());
confirmDestinationBtn.addEventListener("click", () => confirmDestination());

function confirmDestination() {
  if (!start || !destination) { setStatus("Select a destination park first."); return; }

  lockStep1Inputs(true);
  goToStep(2);

  initStopsStep();
}

clearDestinationBtn.addEventListener("click", () => clearDestinationSelection(false));

function clearDestinationSelection(clearMarkersToo) {
  if (clearMarkersToo) clearMarkers(destinationMarkers);

  destination = null;
  setDestinationBtn.disabled = true;
  destinationPreview.style.display = "none";

  if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }

  // Optional: remove buffer when destination is cleared
  // (Keep it if you prefer; I remove it when clearing markers.)
  if (clearMarkersToo && destinationBufferCircle) {
    try { map.removeLayer(destinationBufferCircle); } catch {}
    destinationBufferCircle = null;
  }
}

function resetStopsOnly() {
  candidatePool = [];
  clearMarkers(candidateMarkers);
  selectedStopCandidate = null;
  selectedStops = [];
  googleMapsUrl = null;
  openGoogleBtn.disabled = true;
  stopPreview.style.display = "none";
  itineraryContainer.innerHTML = `<div class="itinerary-empty">Itinerary will populate after you set destination and start adding stops.</div>`;
}

// ---------- Step 2: Modify origin/destination ----------
modifyOriginDestBtn.addEventListener("click", () => {
  lockStep1Inputs(false);
  goToStep(1);
  setStatus("Modify Start / trip settings / destination. Then search destination parks again.");
});

// ---------- Step 2 init ----------
async function initStopsStep() {
  const budget = computeBudgetMiles();
  const intervalMiles = Math.max(10, (parseFloat(stopFreqInput.value || "2") * MPH));

  step2Summary.innerHTML = [
    `<b>Start:</b> ${escapeHtml(start.label)}<br/>`,
    `<b>Destination:</b> ${escapeHtml(destination.unitname)} ${destination.unitcode ? `(${escapeHtml(destination.unitcode)})` : ""}<br/>`,
    `<b>Trip:</b> ${budget.days} days · ${budget.hoursPerDay} hr/day · ${isOneWay ? "One-way" : `Round-trip (${budget.daysAtDest} day(s) at destination)`}<br/>`,
    `<b>Driving budget:</b> ~${budget.totalMiles.toFixed(0)} miles total · outbound ~${budget.outboundMiles.toFixed(0)} miles<br/>`,
    `<b>Stop interval:</b> ~${intervalMiles.toFixed(0)} miles (straight-line)`
  ].join("");

  renderSummaryPills(budget, intervalMiles);

  setStatus("Loading candidate pool (NPS POIs + Places)…");
  await buildCandidatePool(intervalMiles);

  showNextStopCandidates();
  renderItinerary();
}

// ---------- Candidate pool building ----------
async function buildCandidatePool(intervalMiles) {
  candidatePool = [];
  clearMarkers(candidateMarkers);

  const line = turf.lineString([[start.lng, start.lat], [destination.lng, destination.lat]]);
  const corridor = turf.buffer(line, milesToKm(Math.max(20, intervalMiles * 0.55)), { units: "kilometers" });
  const corridorEsri = geojsonPolygonToEsriRings(corridor.geometry);

  // POIs (skip if vibe is "towns")
  if (selectedVibe !== "towns") {
    const where = poiWhereForVibe(selectedVibe);
    try {
      const poiGeo = await arcgisQueryGeoJSON(LAYER_POI, {
        f: "geojson",
        where,
        outFields: "NAME,POITYPE,UNITCODE,UNITNAME",
        returnGeometry: "true",
        outSR: "4326",
        geometry: JSON.stringify({ rings: corridorEsri.rings, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPolygon",
        spatialRel: "esriSpatialRelIntersects",
        resultRecordCount: "400"
      });

      (poiGeo?.features || []).forEach((f) => {
        const props = f.properties || {};
        const name = safeProp(props, "NAME") || "NPS POI";
        const poitype = safeProp(props, "POITYPE") || "POI";
        const unitcode = safeProp(props, "UNITCODE") || "";
        const [lng, lat] = f.geometry.coordinates;

        candidatePool.push({
          source: "NPS",
          kind: "POI",
          name,
          meta: `${poitype}${unitcode ? ` · ${unitcode}` : ""}`,
          lat: +fmt6(lat),
          lng: +fmt6(lng)
        });
      });
    } catch (e) {
      console.warn("POI corridor query failed:", e);
    }
  }

  // Places (gateway towns)
  try {
    const placesGeo = await arcgisQueryGeoJSON(LAYER_PLACES, {
      f: "geojson",
      where: "1=1",
      outFields: "NAME,Size",
      returnGeometry: "true",
      outSR: "4326",
      geometry: JSON.stringify({ rings: corridorEsri.rings, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPolygon",
      spatialRel: "esriSpatialRelIntersects",
      resultRecordCount: "400"
    });

    (placesGeo?.features || []).forEach((f) => {
      const props = f.properties || {};
      const name = safeProp(props, "NAME") || "Place";
      const size = safeProp(props, "Size") || "";
      const [lng, lat] = f.geometry.coordinates;

      candidatePool.push({
        source: "Census",
        kind: "Place",
        name,
        meta: `Gateway town${size !== "" ? ` · Size ${size}` : ""}`,
        lat: +fmt6(lat),
        lng: +fmt6(lng)
      });
    });
  } catch (e) {
    console.warn("Places corridor query failed:", e);
  }

  // Optional: Free OSM amenities via Overpass (best-effort)
  if (useOSM) {
    try {
      setStatus("Loading free OSM amenities (Overpass)…");
      const osm = await fetchOSMAmenitiesAlongCorridor(line, Math.min(25, Math.max(8, intervalMiles * 0.25)));
      osm.forEach((o) => candidatePool.push(o));
    } catch (e) {
      console.warn("OSM amenities failed:", e);
      setStatus("OSM amenities blocked/unavailable. Continuing with NPS POIs + Places.");
    }
  }

  setStatus(`Candidate pool loaded: ${candidatePool.length} features.`);
}

// ---------- Show candidates within interval of last stop ----------
function showNextStopCandidates() {
  const intervalMiles = Math.max(10, (parseFloat(stopFreqInput.value || "2") * MPH));

  const anchor = selectedStops.length
    ? { lat: selectedStops[selectedStops.length - 1].lat, lng: selectedStops[selectedStops.length - 1].lng }
    : { lat: start.lat, lng: start.lng };

  const candidates = candidatePool
    .filter(c => !selectedStops.some(s => s.lat === c.lat && s.lng === c.lng && s.name === c.name))
    .map(c => {
      const d = turf.distance(turf.point([anchor.lng, anchor.lat]), turf.point([c.lng, c.lat]), { units: "miles" });
      return { ...c, distFromAnchor: d };
    })
    .filter(c => c.distFromAnchor <= intervalMiles && c.distFromAnchor >= intervalMiles * 0.30)
    .sort((a, b) => a.distFromAnchor - b.distFromAnchor)
    .slice(0, 40);

  renderCandidateMarkers(candidates, anchor);
}

// ---------- Render candidate markers ----------
function renderCandidateMarkers(candidates, anchor) {
  clearMarkers(candidateMarkers);

  const intervalMiles = Math.max(10, (parseFloat(stopFreqInput.value || "2") * MPH));

  const anchorCircle = L.circle([anchor.lat, anchor.lng], {
    radius: milesToKm(intervalMiles) * 1000,
    weight: 1,
    fillOpacity: 0.05
  }).addTo(map);
  candidateMarkers.push(anchorCircle);

  candidates.forEach((c) => {
    const color = c.source === "NPS" ? "#38bdf8" : (c.source === "Census" ? "#f97316" : "#22c55e");

    const m = L.circleMarker([c.lat, c.lng], {
      radius: 6,
      weight: 2,
      color,
      fillOpacity: 0.55
    }).addTo(map);

    m.on("click", () => previewStopCandidate(c));
    m.bindPopup(`<b>${escapeHtml(c.name)}</b><br/>${escapeHtml(c.meta)}<br/>~${c.distFromAnchor.toFixed(0)} mi from last stop`);

    candidateMarkers.push(m);
  });

  const layers = [startMarker, destinationMarker, ...candidateMarkers].filter(Boolean);
  const group = L.featureGroup(layers);
  map.fitBounds(group.getBounds().pad(0.2));
}

// ---------- Stop preview + add ----------
function previewStopCandidate(c) {
  selectedStopCandidate = c;
  stopPreview.style.display = "block";
  stopTitle.textContent = c.name;
  stopMeta.innerHTML = `
    <b>Type:</b> ${escapeHtml(c.kind)} (${escapeHtml(c.source)})<br/>
    <b>Meta:</b> ${escapeHtml(c.meta)}<br/>
    <b>Coords:</b> ${fmt6(c.lat)}, ${fmt6(c.lng)}
  `;
}

closeStopPreviewBtn.addEventListener("click", () => {
  stopPreview.style.display = "none";
  selectedStopCandidate = null;
});

addStopBtn.addEventListener("click", () => {
  if (!selectedStopCandidate) return;

  selectedStops.push({
    ...selectedStopCandidate,
    stopNumber: selectedStops.length + 1
  });

  stopPreview.style.display = "none";
  selectedStopCandidate = null;

  renderItinerary();
  showNextStopCandidates();

  googleMapsUrl = buildGoogleMapsUrl();
  openGoogleBtn.disabled = !googleMapsUrl;
});

// ---------- Auto-pick stops ----------
autoPickStopsBtn.addEventListener("click", () => {
  const targetCount = 18;
  selectedStops = [];

  for (let i = 0; i < targetCount; i++) {
    const intervalMiles = Math.max(10, (parseFloat(stopFreqInput.value || "2") * MPH));
    const anchor = selectedStops.length
      ? { lat: selectedStops[selectedStops.length - 1].lat, lng: selectedStops[selectedStops.length - 1].lng }
      : { lat: start.lat, lng: start.lng };

    const candidates = candidatePool
      .filter(c => !selectedStops.some(s => s.lat === c.lat && s.lng === c.lng && s.name === c.name))
      .map(c => {
        const d = turf.distance(turf.point([anchor.lng, anchor.lat]), turf.point([c.lng, c.lat]), { units: "miles" });
        return { ...c, distFromAnchor: d };
      })
      .filter(c => c.distFromAnchor <= intervalMiles && c.distFromAnchor >= intervalMiles * 0.30)
      .sort((a, b) => a.distFromAnchor - b.distFromAnchor);

    if (!candidates.length) break;

    let pick = candidates[0];
    if (selectedVibe === "towns") {
      const town = candidates.find(c => c.kind === "Place");
      if (town) pick = town;
    } else {
      const nps = candidates.find(c => c.kind === "POI");
      if (nps) pick = nps;
    }

    selectedStops.push({ ...pick, stopNumber: selectedStops.length + 1 });
  }

  renderItinerary();
  showNextStopCandidates();
  googleMapsUrl = buildGoogleMapsUrl();
  openGoogleBtn.disabled = !googleMapsUrl;
  setStatus(`Auto-picked ${selectedStops.length} stops (MVP).`);
});

// ---------- Itinerary rendering ----------
function renderItinerary() {
  itineraryContainer.innerHTML = "";

  const cards = [];

  cards.push(makeStopCard({
    badge: "S",
    title: "Start",
    meta: `${fmt6(start.lat)}, ${fmt6(start.lng)}`,
    tags: ["Start"],
    desc: start.label
  }));

  selectedStops.forEach((s) => {
    cards.push(makeStopCard({
      badge: s.stopNumber,
      title: s.name,
      meta: s.meta,
      tags: [s.source, s.kind],
      desc: `${fmt6(s.lat)}, ${fmt6(s.lng)}`
    }));
  });

  cards.push(makeStopCard({
    badge: "D",
    title: `Destination: ${destination.unitname}`,
    meta: `${destination.unitcode ? `${destination.unitcode} · ` : ""}${destination.distMiles.toFixed(0)} mi from Start`,
    tags: ["Destination", isOneWay ? "One-way" : "Round-trip"],
    desc: `${fmt6(destination.lat)}, ${fmt6(destination.lng)}`
  }));

  cards.forEach(c => itineraryContainer.appendChild(c));
  renderSelectedStopsOnMap();
}

function makeStopCard({ badge, title, meta, tags, desc }) {
  const card = document.createElement("div");
  card.className = "stop-card";

  const b = document.createElement("div");
  b.className = "stop-badge";
  b.textContent = badge;

  const main = document.createElement("div");
  main.className = "stop-card-main";

  const t = document.createElement("div");
  t.className = "stop-title";
  t.textContent = title;

  const m = document.createElement("div");
  m.className = "stop-meta";
  m.textContent = meta || "";

  const tagRow = document.createElement("div");
  tagRow.className = "stop-tag-row";
  (tags || []).forEach((tg) => {
    const tag = document.createElement("span");
    tag.className = "stop-tag";
    tag.textContent = tg;
    tagRow.appendChild(tag);
  });

  const d = document.createElement("div");
  d.className = "stop-meta";
  d.textContent = desc || "";

  main.appendChild(t);
  main.appendChild(m);
  main.appendChild(tagRow);
  main.appendChild(d);

  card.appendChild(b);
  card.appendChild(main);

  return card;
}

function renderSelectedStopsOnMap() {
  candidateMarkers = candidateMarkers.filter((m) => {
    if (m.__selectedStop) { try { map.removeLayer(m); } catch {} return false; }
    return true;
  });

  selectedStops.forEach((s) => {
    const m = L.marker([s.lat, s.lng]).addTo(map);
    m.__selectedStop = true;
    m.bindPopup(`<b>Stop ${s.stopNumber}:</b> ${escapeHtml(s.name)}<br/>${escapeHtml(s.meta)}`);
    candidateMarkers.push(m);
  });
}

// ---------- Google Maps ----------
openGoogleBtn.addEventListener("click", () => {
  if (!googleMapsUrl) return;
  window.open(googleMapsUrl, "_blank");
});

function buildGoogleMapsUrl() {
  if (!start || !destination) return null;
  const maxStops = 10;
  const pts = [];
  pts.push(`${start.lat},${start.lng}`);
  selectedStops.slice(0, maxStops).forEach(s => pts.push(`${s.lat},${s.lng}`));
  pts.push(`${destination.lat},${destination.lng}`);
  return `https://www.google.com/maps/dir/${pts.join("/")}`;
}

// ---------- Summary pills ----------
function renderSummaryPills(budget, intervalMiles) {
  summaryPills.innerHTML = "";
  summaryPills.style.display = "flex";

  const pills = [
    `🛣️ ~${budget.totalMiles.toFixed(0)} mi total`,
    `🎯 Buffer: ${budget.outboundMiles.toFixed(0)} mi`,
    `⏱️ Interval: ~${intervalMiles.toFixed(0)} mi`,
    `🚗 ${budget.hoursPerDay} hr/day @ ${MPH} mph`,
    isOneWay ? "➡️ One-way" : `🔁 Round-trip · ${budget.daysAtDest} day(s) at dest`
  ];

  pills.forEach((txt) => {
    const el = document.createElement("div");
    el.className = "summary-pill";
    el.textContent = txt;
    summaryPills.appendChild(el);
  });
}

// ---------- OSM amenities (Overpass) ----------
async function fetchOSMAmenitiesAlongCorridor(line, bufferMiles) {
  const coords = line.geometry.coordinates;
  const p0 = coords[0];
  const p1 = coords[1];

  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  const q1  = [(p0[0] * 0.75 + p1[0] * 0.25), (p0[1] * 0.75 + p1[1] * 0.25)];
  const q3  = [(p0[0] * 0.25 + p1[0] * 0.75), (p0[1] * 0.25 + p1[1] * 0.75)];

  const points = [q1, mid, q3];
  const radiusM = Math.round(milesToKm(bufferMiles) * 1000);

  const all = [];
  for (const [lng, lat] of points) {
    const query = `
      [out:json][timeout:25];
      (
        node(around:${radiusM},${lat},${lng})["amenity"="fuel"];
        node(around:${radiusM},${lat},${lng})["amenity"="restaurant"];
        node(around:${radiusM},${lat},${lng})["tourism"="hotel"];
      );
      out center 60;
    `.trim();

    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: query
    });

    if (!res.ok) throw new Error(`Overpass failed: ${res.status}`);
    const data = await res.json();

    for (const el of (data.elements || [])) {
      if (el.type !== "node") continue;
      const name = (el.tags && el.tags.name) ? el.tags.name : "OSM Amenity";
      const kind =
        el.tags?.amenity === "fuel" ? "Fuel" :
        el.tags?.amenity === "restaurant" ? "Food" :
        el.tags?.tourism === "hotel" ? "Hotel" : "Amenity";

      all.push({
        source: "OSM",
        kind,
        name,
        meta: `Free OSM · ${kind}`,
        lat: +fmt6(el.lat),
        lng: +fmt6(el.lon)
      });
    }
  }

  const seen = new Set();
  return all.filter(o => {
    const k = `${o.kind}:${o.lat.toFixed(4)}:${o.lng.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------- Geometry conversion ----------
function geojsonPolygonToEsriRings(geojsonGeom) {
  const rings = [];
  if (geojsonGeom.type === "Polygon") {
    geojsonGeom.coordinates.forEach((ring) => rings.push(ring.map(([x, y]) => [x, y])));
  } else if (geojsonGeom.type === "MultiPolygon") {
    geojsonGeom.coordinates.forEach((poly) => poly.forEach((ring) => rings.push(ring.map(([x, y]) => [x, y]))));
  } else {
    throw new Error(`Unsupported geometry: ${geojsonGeom.type}`);
  }
  return { rings };
}

// ---------- Reset ----------
resetBtn.addEventListener("click", () => resetAll());

function resetAll() {
  selectedVibe = "scenic";
  isOneWay = false;
  useOSM = false;
  start = null;
  destination = null;

  originInput.value = "";
  originError.style.display = "none";

  toggleRoundtrip.classList.add("active");
  toggleOneway.classList.remove("active");
  daysAtDestGroup.style.display = "block";

  toggleOsm.textContent = "OSM amenities: OFF";
  toggleOsm.classList.remove("active");

  document.querySelectorAll(".pill-radio").forEach(p => p.classList.remove("active"));
  document.querySelector('.pill-radio[data-value="scenic"]').classList.add("active");

  if (startMarker) { map.removeLayer(startMarker); startMarker = null; }
  if (destinationMarker) { map.removeLayer(destinationMarker); destinationMarker = null; }

  if (destinationBufferCircle) { try { map.removeLayer(destinationBufferCircle); } catch {} destinationBufferCircle = null; }

  clearMarkers(destinationMarkers);
  clearMarkers(candidateMarkers);

  itineraryContainer.innerHTML = `<div class="itinerary-empty">Itinerary will populate after you set destination and start adding stops.</div>`;

  destinationPreview.style.display = "none";
  setDestinationBtn.disabled = true;

  lockStep1Inputs(false);
  goToStep(1);

  openGoogleBtn.disabled = true;

  map.setView([39.5, -98.35], 5);
  setStatus("Click on the map to set Start, or type an address and press Set Start.");
}

// ---------- Initial ----------
goToStep(1);
setStatus("Click on the map to set Start, or type an address and press Set Start.");
