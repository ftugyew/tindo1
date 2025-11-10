// Tindo v2 — Live Tracking
// Author: Sravan
// Description: Real-time delivery agent tracking and ETA progress visualization.

mapboxgl.accessToken = "YOUR_MAPBOX_ACCESS_TOKEN"; // <-- Replace with your Mapbox token
const map = new mapboxgl.Map({
  container: "map",
  style: "mapbox://styles/mapbox/streets-v11",
  center: [78.4867, 17.3850], // Default: Hyderabad
  zoom: 12,
});

// Example: coordinates from DB
const restaurantLoc = [78.4867, 17.3850];
const userLoc = [78.5010, 17.4000];
let agentLoc = [78.4900, 17.3920];

// Markers
const restaurantMarker = new mapboxgl.Marker({ color: "#2ecc71" })
  .setLngLat(restaurantLoc)
  .setPopup(new mapboxgl.Popup().setText("Restaurant"))
  .addTo(map);

const userMarker = new mapboxgl.Marker({ color: "#27ae60" })
  .setLngLat(userLoc)
  .setPopup(new mapboxgl.Popup().setText("Your Location"))
  .addTo(map);

let agentMarker = new mapboxgl.Marker({ color: "#f39c12" })
  .setLngLat(agentLoc)
  .setPopup(new mapboxgl.Popup().setText("Delivery Agent"))
  .addTo(map);

// Draw route
async function drawRoute() {
  const query = await fetch(
    `https://api.mapbox.com/directions/v5/mapbox/driving/${restaurantLoc[0]},${restaurantLoc[1]};${userLoc[0]},${userLoc[1]}?steps=true&geometries=geojson&access_token=${mapboxgl.accessToken}`
  );
  const json = await query.json();
  const data = json.routes[0];
  const route = data.geometry.coordinates;

  map.addSource("route", {
    type: "geojson",
    data: {
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: route },
    },
  });

  map.addLayer({
    id: "route",
    type: "line",
    source: "route",
    layout: { "line-join": "round", "line-cap": "round" },
    paint: { "line-color": "#2ecc71", "line-width": 5 },
  });

  map.fitBounds([restaurantLoc, userLoc], { padding: 60 });
}

// Animate progress bar (ETA countdown)
let totalTime = 20; // 20 minutes
let remainingTime = totalTime;
const progressBar = document.getElementById("progress");
const etaText = document.getElementById("eta");

function updateProgress() {
  remainingTime -= 1;
  const progress = ((totalTime - remainingTime) / totalTime) * 100;
  progressBar.style.width = `${progress}%`;
  etaText.innerText = `ETA: ${remainingTime} min`;

  if (remainingTime <= 0) {
    etaText.innerText = "Delivered ✅";
    clearInterval(timer);
  }
}
const timer = setInterval(updateProgress, 60000); // 1 min

// Live updates via Socket.io
const BASE_URL = "http://localhost:5000"; // Express backend
const socket = io(BASE_URL);
socket.emit("trackOrder", { orderId: "ORD123" });

socket.on("orderLocation", (data) => {
  agentLoc = [data.lng, data.lat];
  agentMarker.setLngLat(agentLoc);
});

// Initial route draw
map.on("load", drawRoute);
