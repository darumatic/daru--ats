// Great-circle distance between two lat/lng points.
//
// Candidates carry addressLatitude/addressLongitude and job orders carry
// locationLatitude/locationLongitude - both filled in by the address typeahead
// - so a real distance is available whenever both sides were entered through
// it. Callers must handle null: a hand-typed address has no coordinates, and a
// guessed distance would be worse than admitting there isn't one.

const EARTH_RADIUS_MILES = 3958.7613;

function toRadians(degrees) {
	return (degrees * Math.PI) / 180;
}

function toFiniteCoordinate(value, limit) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return null;
	if (Math.abs(parsed) > limit) return null;
	return parsed;
}

export function toGeoPoint(latitude, longitude) {
	const lat = toFiniteCoordinate(latitude, 90);
	const lng = toFiniteCoordinate(longitude, 180);
	if (lat === null || lng === null) return null;
	// 0,0 is in the Gulf of Guinea and is almost always an unfilled column
	// rather than a real address, so it is treated as missing.
	if (lat === 0 && lng === 0) return null;
	return { lat, lng };
}

export function haversineMiles(from, to) {
	if (!from || !to) return null;

	const latDelta = toRadians(to.lat - from.lat);
	const lngDelta = toRadians(to.lng - from.lng);
	const a =
		Math.sin(latDelta / 2) ** 2 +
		Math.cos(toRadians(from.lat)) * Math.cos(toRadians(to.lat)) * Math.sin(lngDelta / 2) ** 2;

	return EARTH_RADIUS_MILES * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}
