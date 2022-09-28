if (process.env['http_proxy']) {
    console.log("Using global http proxy", process.env['http_proxy']);
    const proxy = require("node-global-proxy").default;
    proxy.setConfig({
        http: process.env['http_proxy'],
        https: process.env['https_proxy'],
    });
    proxy.start();
}

const OverpassFrontend = require('overpass-frontend')
const overpassFrontend = new OverpassFrontend('//overpass-api.de/api/interpreter')

const fs = require('fs');
const toGeoJSON = require('togeojson');
const DOMParser = require('xmldom').DOMParser;

const parsed = toGeoJSON.gpx(new DOMParser().parseFromString(fs.readFileSync(process.argv[2], 'utf8')));
const points = parsed.features[0].geometry.coordinates
console.log("Found",points.length, "gpx waypoints.");

const calculateBBox = (points) => {
    const min = {lat: Infinity, lon: Infinity};
    const max = {lat: -Infinity, lon: -Infinity};
    for(const point of points) {
        if(point[1] < min.lat) min.lat = point[1];
        if(point[1] > max.lat) max.lat = point[1];
        if(point[0] < min.lon) min.lon = point[0];
        if(point[0] > max.lon) max.lon = point[0];
    }
    return {min, max};
}

function bboxCenter(bbox) {
    return {lat: (bbox.min.lat + (bbox.max.lat - bbox.min.lat) * 0.5), lon: (bbox.min.lon + (bbox.max.lon - bbox.min.lon) * 0.5)}
}

const bbox = calculateBBox(points);

console.log("Bounds", bbox);

const Config = JSON.parse(fs.readFileSync(process.argv[3]));

let cache = null;
if(fs.existsSync('cache.json')) {
    cache = JSON.parse(fs.readFileSync('cache.json'));
}

let foundList = [];
const usedTags = [];

function geometryToPoint(geo) {
    if(geo.lat && geo.lon) {
        return geo;
    } else if(geo.length) {
        return bboxCenter(calculateBBox(geo.map(e => [e.lon, e.lat])));
    } else if(geo.type === 'FeatureCollection'){
        return bboxCenter(calculateBBox(geo.features[0].geometry.coordinates[0]));
    }
}

async function query(qry) {
    return new Promise((resolve) => {
        overpassFrontend.BBoxQuery(
            qry,
            { minlat: bbox.min.lat, maxlat: bbox.max.lat, minlon: bbox.min.lon, maxlon: bbox.max.lon },
            {
              properties: OverpassFrontend.ALL
            },
            function (err, result) {
                if(result.tags.name !== undefined) {
                    for(const key in result.tags) {
                        if(usedTags.includes(key)) {
                            const cfg = Config.points.find(e => e.tag === key && e.value === result.tags[key]);
                            if(cfg) {
                                foundList.push({
                                    config: cfg,
                                    geometry: result.geometry,
                                    name: result.tags.name
                                });
                            }
                            break;
                        }
                    }
                }
            },
            function (err) {
              if (err) { console.log(err); process.exit(); }
              resolve();
          },
          )
    })
}

function pointDistance(p1, p2) {
    return Math.sqrt(Math.pow(p2[0] - p1[0], 2) +  Math.pow(p2[1] - p1[1], 2));
}

function findClosestPoint(pointList, to) {
    let closestIndex = 0;
    let closestPoint = pointList[0];
    let i = 0;
    for(const point of pointList) {
        if(pointDistance(point, to) < pointDistance(closestPoint, to)) {
            closestIndex = i;
            closestPoint = point;
        }
        i++;
    }
    return {point: closestPoint, index: closestIndex};
}

function calcCrow(lat1, lon1, lat2, lon2) 
{
  var R = 6371; // km
  var dLat = toRad(lat2-lat1);
  var dLon = toRad(lon2-lon1);
  var lat1 = toRad(lat1);
  var lat2 = toRad(lat2);

  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c;
  return d;
}

function toRad(Value) 
{
    return Value * Math.PI / 180;
}

function matchesFilter(feature, config) {
    if(config.filter === undefined) return true;
    let match = true;
    if(config.filter.name) {
        let found = false;
        for(const name of config.filter.name) {
            if(feature.name.toLowerCase().includes(name.toLowerCase())) {
                found = true;
                break;
            }
        }
        match = found;
    }
    return match;
}


(async () => {
    const beforeQuery = Date.now();
    if(process.argv.includes('use_cache')) {
        console.log("Using data from cache.");
        foundList = cache.foundList;
    } else {
        for(const tag of Config.points.map(e => e.tag)) {
            usedTags.push(tag);
        }
        for(const pt of Config.points) {
            const osmQuery = `nwr[${pt.tag}=${pt.value}]`;
            console.log("Running query", osmQuery);
            await query(osmQuery);
        }
        fs.writeFileSync('cache.json', JSON.stringify({
            foundList,
            Config,
            source: process.argv[2]
        }));
    }
    console.log("Query duration", (Date.now() - beforeQuery), "ms");
    console.log("Raw dataset length:", foundList.length);
    const beforeFilter = Date.now();
    const inRange = [];
    for(const feature of foundList) {
        feature.point = geometryToPoint(feature.geometry);
        const waypoint = findClosestPoint(points, [feature.point.lon, feature.point.lat]);
        const waypointDistance = calcCrow(waypoint.point[1], waypoint.point[0], feature.point.lat, feature.point.lon);
        if(isNaN(waypointDistance)) console.log(feature);
        feature.config = Config.points.find(e => e.tag === feature.config.tag && e.value === feature.config.value);
        if(waypointDistance <= feature.config.min_distance) {
            feature.geometry.lat = waypoint.point[1];
            feature.geometry.lon = waypoint.point[0];
            feature.distance = waypointDistance;
            if(matchesFilter(feature, feature.config)) {
                inRange.push(feature);
            }
        }
    }
    console.log("Filter duration", (Date.now() - beforeFilter), "ms");
    const beforeBuild = Date.now();
    const { buildGPX, GarminBuilder } = require('gpx-builder');
    const { Point } = GarminBuilder.MODELS;

    const trackPoints = points.map(p => new Point(p[1], p[0], {ele: p[2]}));

    const gpxData = new GarminBuilder();

    gpxData.setSegmentPoints(trackPoints);
    gpxData.setWayPoints(inRange.map( p => new Point(p.geometry.lat, p.geometry.lon, {type: p.config.marker, name: p.name})));

    fs.writeFileSync(process.argv[4], buildGPX(gpxData.toObject()));

    console.log("Build duration", (Date.now() - beforeBuild), "ms");
    console.log("Done. Added", inRange.length, "waypoints.");
    for(const pt of Config.points) {
        console.log(`${pt.tag}=${pt.value}:`, inRange.filter(e => e.config.tag === pt.tag && e.config.value === pt.value).length, "/", foundList.filter(e => e.config.tag === pt.tag && e.config.value === pt.value).length);
    }
})();

