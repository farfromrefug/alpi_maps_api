var request = require('request');
var geolib = require('geolib');
var Canvas = require('canvas');
var SphericalMercator = require('sphericalmercator');
var _ = require('lodash');
var Promise = require('bluebird');

// node cachemanager
var cacheManager = require('cache-manager');
// storage for the cachemanager
var fsStore = require('cache-manager-fs');

// initialize caching on disk
var multiCache = cacheManager.multiCaching([cacheManager.caching({
    store: 'memory',
    max: 60,
    ttl: 60 /*seconds*/

}), cacheManager.caching({
    store: fsStore,
    options: {
        ttl: 24 * 7 * 60 * 60 /* seconds */ ,
        maxsize: 200 * 1000 * 1000 /* max size in bytes on disk */ ,
        path: 'tilesCache/',
        // preventfill: true
    }
})]);

var WMS_ORIGIN_X = -20037508.34789244;
var WMS_ORIGIN_Y = 20037508.34789244;
var WMS_MAP_SIZE = 20037508.34789244 * 2;

function getSubdomain(t, subdomains) {
    // sdebug('getSubdomain', subdomains);
    if (subdomains) {
        var index = (t.x + t.y) % subdomains.length;
        return subdomains.charAt(index);
    } else {
        return '';
    }
}

function getTileUrl(r, t) {
    var url = r.url.replace('{s}', getSubdomain(t, r.subdomains || 'abc'));
    if (url.indexOf('{bbox}') >= 0) {
        var tileSize = WMS_MAP_SIZE / Math.pow(2, t.z);
        var minx = WMS_ORIGIN_X + t.x * tileSize;
        var maxx = WMS_ORIGIN_X + (t.x + 1) * tileSize;
        var miny = WMS_ORIGIN_Y - (t.y + 1) * tileSize;
        var maxy = WMS_ORIGIN_Y - t.y * tileSize;
        return url.replace('{bbox}', minx + ',' + miny + ',' + maxx + ',' + maxy);
    } else {
        return url.replace('{x}', t.x).replace('{y}', t.y).replace('{z}', t.z);
    }
}

function getBoundsZoomLevel(bounds, imageSize) {
    var worldDim = 256;
    var zoomMax = 22;

    function latRad(lat) {
        var sin = Math.sin(lat * Math.PI / 180);
        var radX2 = Math.log((1 + sin) / (1 - sin)) / 2;
        return Math.max(Math.min(radX2, Math.PI), -Math.PI) / 2;
    }

    function zoom(mapPx, worldPx, fraction) {
        return Math.round(Math.log(mapPx / worldPx / fraction) / Math.LN2);
    }

    var ne = bounds.ne;
    var sw = bounds.sw;

    var latFraction = (latRad(ne.latitude) - latRad(sw.latitude)) / Math.PI;

    var lngDiff = ne.longitude - sw.longitude;
    var lngFraction = ((lngDiff < 0) ? (lngDiff + 360) : lngDiff) / 360;

    var latZoom = zoom(imageSize.height, worldDim, latFraction);
    var lngZoom = zoom(imageSize.width, worldDim, lngFraction);

    return Math.min(Math.min(latZoom, lngZoom), zoomMax);
}

var fetchTile = function(r, t, callback) {
    var url = getTileUrl(r, t);
    // Return a new promise.

    return multiCache.wrap(url, function() {

        return new Promise(function(resolve, reject) {
            // console.log('fetchTile', url);

            function get(r, gattempts, resolve, reject) {
                request.defaults({
                    headers: r.headers,
                    encoding: null
                }).get(url, function(error, response, body) {
                    // console.log('fetch ' + url + ' ' + response.statusCode + ' ' + error);
                    if (!error && response.statusCode == 200) {
                        // console.log("data fetched " + url);
                        // var result = new Buffer(body, 'base64');
                        resolve(body);
                    } else if (response.statusCode !== 404 && response.statusCode !== 403 &&
                        gattempts <
                        3) {
                        get(r, gattempts + 1, resolve, reject);
                    } else {
                        reject(Error(error || 'can\'t fetch tile:' + url));
                    }
                });
            }
            get(r, 0, resolve, reject);
        });
    }).then(callback);
};

function staticMap(r, callback) {
    var layers = r.layers;

    if (!layers || !_.isArray(layers) || layers.length === 0) {
        callback(new Error("missing layers parameter"), null);
    }

    _.each(layers, function(layer) {
        layer.url = decodeURIComponent(layer.url);
    })

    r.width = r.width || 500;
    r.height = r.height || 500;
    // List tiles
    // console.log('staticMap' + typeof r.bounds);
    var bounds = r.bounds;
    var zoom = getBoundsZoomLevel(bounds, r);
    // var tilesData = listTiles(r, zoom); //separated in chunks
    // var tiles = tilesData.tiles;
    var merc = new SphericalMercator({
        size: 256
    });
    var xyz = merc.xyz([bounds.sw.longitude, bounds.sw.latitude, bounds.ne.longitude, bounds.ne.latitude], zoom);
    var xCount = xyz.maxX - xyz.minX + 1;
    var yCount = xyz.maxY - xyz.minY + 1;
    var center = geolib.getCenter([r.bounds.ne, r.bounds.sw]);
    var centerXY = _.map(merc.px([parseFloat(center.longitude), parseFloat(center.latitude)], zoom), function(value) {
        return value / 256;
    });

    var xRatio = (centerXY[0] - xyz.minX) / xCount;
    var yRatio = (centerXY[1] - xyz.minY) / yCount;
    // console.log('xLength ' + xCount);
    // console.log('yLength ' + yCount);
    // console.log('xyz ' + JSON.stringify(xyz));
    // console.log('center ' + JSON.stringify(center));
    // console.log('centerXY ' + JSON.stringify(centerXY));
    // console.log('xRatio ' + xRatio);
    // console.log('yRatio ' + yRatio);

    var deltaX = Math.floor(r.width * xRatio - r.width / 2) + (r.width - xCount * 256) / 2;
    var deltaY = Math.floor(r.height * yRatio - r.height / 2) + (r.height - yCount * 256) / 2;
    // console.log('deltaX ' + deltaX);
    // console.log('deltaY ' + deltaY);

    var canvas = new Canvas(r.width, r.height),
        // var canvas = new Canvas(xCount*256, yCount*256),
        ctx = canvas.getContext('2d');

    var img;

    var sequences = [];
    for (var x = 0; x < xCount; x++) {
        for (var y = 0; y < yCount; y++) {
            sequence = Promise.resolve();
            _.each(layers, function(layer) {
                (function(x, y) {
                    sequence = sequence.then(function() {
                        // Wait for everything in the sequence so far,
                        // then wait for this chapter to arrive.
                        return fetchTile(layer, {
                            x: x + xyz.minX,
                            y: y + xyz.minY,
                            z: zoom
                        }, function(data) {
                            // console.log('on data', data);
                            if (data) {

                                img = new Canvas.Image;
                                img.src = new Buffer(data, 'base64');
                                ctx.drawImage(img, deltaX + x * 256, deltaY + y * 256, 256,
                                    256);
                            }
                        });
                    });
                })(x, y);
            });
            sequences.push(sequence);
            // _.each(layers, function(layer) {
            //     (function(x, y) {
            //         sequence = sequence.then(function() {
            //             // Wait for everything in the sequence so far,
            //             // then wait for this chapter to arrive.
            //             return
            //         });
            //     })(x, y);
            // });

        }
    }
    Promise.all(sequences).then(function() {
        // console.log('all tiles fetched');

        callback(null, canvas.toBuffer());
    }).catch(function(e) {
        console.log('error', e);
        callback(new Error(e), null);
    });
}

function prepareParams(req) {
    var params = req.query;
    return _.mapValues(params, function(value) {
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
    })
}
module.exports = function(app) {
    app.get('/staticmap', function(req, res) {
        var fullUrl = req.protocol + '://' + req.get('host') + req.originalUrl;
        console.log(fullUrl);
        console.log(req.query);
        var params = prepareParams(req);
        // console.log('params' + JSON.stringify(params));
        staticMap(params, function(err, data) {
            // console.log('staticMap' + err, data);
            if (!err) {
                // res.send();
                res.writeHead(200, {
                    'Content-Type': 'image/png'
                });
                res.end(data); // Send the file data to the browser.
                // res.send(data);
            } else {

                res.status(500).send(err.message);
            }
        });
    });
}