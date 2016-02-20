#!/bin/env node
 //  OpenShift sample Node application
var express = require('express');
var fs = require('fs');
var os = require('os');
var _ = require('lodash');
var mod_path = require('path');
var slang = require('slang');
var process = require('process');
var spawn = require('child_process').spawn;
var mod_bunyan = require('bunyan');
var request = require('request');
var geolib = require('geolib');
var Promise = require('bluebird');
var SphericalMercator = require('sphericalmercator');
// var mod_spawnasync = require('spawn-async');
var concat = require('concat-stream');
var bodyParser = require('body-parser');
var log = new mod_bunyan({
    'name': mod_path.basename(process.argv[1]),
    'level': process.env['LOG_LEVEL'] || 'debug'
});
wkhtmltopdfcommand = './bin/linux/' + 'wkhtmltopdf';

var Canvas;
if (os.platform() == 'darwin') {
    Canvas = require('canvas');
    wkhtmltopdfcommand = './bin/osx/' + 'wkhtmltopdf'
} else {
    Canvas = require('canvas');
}

function quote(val) {
    // escape and quote the value if it is a string and this isn't windows
    if (typeof val === 'string')
        val = '"' + val.replace(/(["\\$`])/g, '\\$1') + '"';

    return val;
}

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

var fetchTile = function(r, t) {
    var url = getTileUrl(r, t);
    // console.log('fetchTile ' + r.layer.userAgent);
    // Return a new promise.
    return new Promise(function(resolve, reject) {
        function get(r, gattempts, resolve, reject) {
            request.defaults({
                headers: r.headers,
                encoding: null
            }).get(url, function(error, response, body) {
                // console.log('fetch ' + url + ' ' + response.statusCode + ' ' + error);
                if (!error && response.statusCode == 200) {
                    // console.log("data fetched " + url);
                    resolve(new Buffer(body, 'base64'));
                } else if (response.statusCode !== 404 && response.statusCode !== 403 && gattempts <
                    3) {
                    get(r, gattempts + 1, resolve, reject);
                } else {
                    reject(Error(error || 'can\'t fetch tile:' + url));
                }
            });
        }
        get(r, 0, resolve, reject);

    });
};

function staticMap(r, callback) {
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

    var sequence = Promise.resolve(),
        img;
    for (var x = 0; x < xCount; x++) {
        for (var y = 0; y < yCount; y++) {
            (function(x, y) {
                sequence = sequence.then(function() {
                    // Wait for everything in the sequence so far,
                    // then wait for this chapter to arrive.
                    return fetchTile(r, {
                        x: x + xyz.minX,
                        y: y + xyz.minY,
                        z: zoom
                    });
                }).then(function(data) {
                    if (data) {
                        img = new Canvas.Image;
                        // console.log('drawing ' + x + ',' + y);
                        img.src = data;
                        // var img = tiles[x * tilesData.yCount + y].data;
                        // ctx.drawImage(img,  x * 256,  y * 256, 256, 256);
                        ctx.drawImage(img, deltaX + x * 256, deltaY + y * 256, 256, 256);
                    }
                });
            })(x, y);

        }
    }
    sequence.then(function() {
        console.log('all tiles fetched');

        callback(null, canvas.toBuffer());
    }).catch(function(e) {
        // setTimeout(function() {
        //     throw e;
        // }, 0);
        callback(new Error(e), null);
    });
    // _(tiles).map(_.partial(fetchTile, r)).reduce(function(sequence, fetchPromise) {
    //     // Use reduce to chain the promises together,
    //     // adding content to the page for each chapter
    //     return sequence.then(function() {
    //         // Wait for everything in the sequence so far,
    //         // then wait for this chapter to arrive.
    //         return fetchPromise;
    //     }).then(function(data) {
    //         if (data) {
    //             data.tile.data = data.data;
    //             // insertTile(data.r, data.tile, data.data)
    //         }
    //     });
    // }, Promise.resolve()).then(function() {
    //     console.log('all tiles fetched');
    //     var canvas = new Canvas(tilesData.xCount * 256, tilesData.yCount * 256),
    //         ctx = canvas.getContext('2d');
    //     for (var x = 0; x < tilesData.xCount; x++) {
    //         for (var y = 0; y < tilesData.yCount; y++) {
    //             var img = new Canvas.Image;
    //             var index = x * tilesData.yCount + y;
    //             var tile = tiles[index];
    //             console.log('drawing ' + index + ',' + x + ',' + y + ',' + tile.x + ',' + tile.y);
    //             img.src = tile.data;
    //             // var img = tiles[x * tilesData.yCount + y].data;
    //             ctx.drawImage(img, x * 256, y * 256, 256, 256);
    //         }
    //     }
    //     callback(canvas.toBuffer());
    // }).catch(function(e) {
    //     setTimeout(function() {
    //         throw e;
    //     }, 0);
    //     callback(new Error(e));
    // });
}

function execute(command, args, options) {
    var cp;
    var promise = new Promise(function(resolve, reject) {
        var stderr = new Buffer('');
        var stdout = new Buffer('');

        // Buffer output, reporting progress
     console.log("call made is::", command, args.join(' '));
       cp = spawn(command, args, options);

        if (cp.stdout) {
            cp.stdout.on('data', function(data) {
                stdout = Buffer.concat([stdout, data]);
            });
        }
        if (cp.stderr) {
            cp.stderr.on('data', function(data) {
                stderr = Buffer.concat([stderr, data]);
            });
        }

        // If there is an error spawning the command, reject the promise
        cp.on('error', reject);

        // Listen to the close event instead of exit
        // They are similar but close ensures that streams are flushed
        cp.on('close', function(code) {
            var fullCommand;
            var error;
            if (code) {
                var err = stderr.toString();
                if (/Exit with code 1 due to network error/.test(err)) {
                    code = 0;
                }
            }
            // stdout = stdout.toString();
            // stderr = stderr.toString();

            if (!code) {
                return resolve({
                    stdout: stdout,
                    stderr: stderr
                });
            }

            // Generate the full command to be presented in the error message
            args = args || [];
            fullCommand = command;
            fullCommand += args.length ? ' ' + args.join(' ') : '';

            // Build the error instance
            var error = new Error('Failed to execute "' + fullCommand + '", exit code of #' + code);
            error.code = 'ECMDERR';
            _.assign(error, {
                stderr: stderr,
                stdout: stdout,
                details: stderr,
                status: code,
            });

            return reject(error);
        });
    });

    promise.cp = cp;

    return promise;
}

function wkhtmltopdf(url, params, callback) {
    callback = callback || Function.prototype
        // console.log('wkhtmltopdf', wkhtmltopdfcommand);
    var args = [];
    _.each(params, function(value, key) {
        if (_.isArray(value)) {
            _.each(value, function(array_val) {
                args.push("--" + key);
                args.push(quote(array_val.name));
                args.push(quote(array_val.value));
            });
        } else {
            if (key !== 'toc' && key !== 'cover' && key !== 'page')
                key = key.length === 1 ? '-' + key : '--' + slang.dasherize(key);

            if (value !== false)
                args.push(key);

            if (typeof value !== 'boolean')
                args.push(quote(value));
        }
    });
    args.push(quote(url)); // stdin if HTML given directly
    args.push('-'); // stdin if HTML given directly
    // this nasty business prevents piping problems on linux
    // console.log("call made is::", "/bin/sh", ["-c", args.join(' ')]);
    // var worker = mod_spawnasync.createWorker({
    //     'log': log
    // });
    // worker.aspawn(['/bin/sh', "-c", args.join(' ')],
    //     function(err, stdout, stderr) {
    //         if (err) {
    //             console.log('error: %s', err.message);
    //             console.error(stderr);
    //         } else {
    //             console.log(stdout);
    //             res.send(stdout);
    //         }
    //     });

    return execute(wkhtmltopdfcommand, args, {
            // cwd: '~/foo'
        })
        .then(function(io) {
            // console.log(io.stdout);
            // console.log(io.stderr);
             console.log('test', io.stderr.toString());
           callback(null, io.stdout);
        }, function(err) {
            // Both stdout and stderr are also set on the error object

            console.log('Command failed', err.message, err.status);
            console.log(err.stderr.toString());
            callback(new Error(err));
        });
    // var child = spawn('/bin/sh', ['-c', args.join(' ')], {
    //     stdio: ['pipe', 'pipe', 'pipe']
    // });
    // var buffer = new Buffer();
    // child.stdout.on('data', function(data) {
    //     buffer
    // });
    // child.on('close', function(code) {
    //     callback(null, buffer);
    // });
    // // setup error handling
    // var stream = child.stderr;

    // function handleError(err) {
    //     if (debug) {
    //         console.log('handleError()');
    //         console.log(err);
    //     }

    //     child.removeAllListeners('exit');
    //     child.kill();

    //     callback(new Error(err));
    // }

    // stream.on('error', handleError);

    // var write = concat(function(data) {
    //     callback(null, data);
    // });

    // child.stdout.pipe(write);
    // return stream;
}
/**
 *  Define the sample application.
 */
var SampleApp = function() {

    //  Scope.
    var self = this;

    /*  ================================================================  */
    /*  Helper functions.                                                 */
    /*  ================================================================  */

    /**
     *  Set up server IP address and port # using env variables/defaults.
     */
    self.setupVariables = function() {
        //  Set the environment variables we need.
        self.ipaddress = process.env.OPENSHIFT_NODEJS_IP;
        self.port = process.env.OPENSHIFT_NODEJS_PORT || 8080;

        if (typeof self.ipaddress === "undefined") {
            //  Log errors on OpenShift but continue w/ 127.0.0.1 - this
            //  allows us to run/test the app locally.
            console.warn('No OPENSHIFT_NODEJS_IP var, using 127.0.0.1');
            self.ipaddress = "127.0.0.1";
        };
    };

    /**
     *  Populate the cache.
     */
    self.populateCache = function() {
        if (typeof self.zcache === "undefined") {
            self.zcache = {
                'index.html': ''
            };
        }

        //  Local cache for static content.
        self.zcache['index.html'] = fs.readFileSync('./index.html');
    };

    /**
     *  Retrieve entry (content) from cache.
     *  @param {string} key  Key identifying content to retrieve from cache.
     */
    self.cache_get = function(key) {
        return self.zcache[key];
    };

    /**
     *  terminator === the termination handler
     *  Terminate server on receipt of the specified signal.
     *  @param {string} sig  Signal to terminate on.
     */
    self.terminator = function(sig) {
        if (typeof sig === "string") {
            console.log('%s: Received %s - terminating sample app ...',
                Date(Date.now()), sig);
            process.exit(1);
        }
        console.log('%s: Node server stopped.', Date(Date.now()));
    };

    /**
     *  Setup termination handlers (for exit and a list of signals).
     */
    self.setupTerminationHandlers = function() {
        //  Process on exit and signals.
        process.on('exit', function() {
            self.terminator();
        });

        // Removed 'SIGPIPE' from the list - bugz 852598.
        ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
            'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
        ].forEach(function(element, index, array) {
            process.on(element, function() {
                self.terminator(element);
            });
        });
    };

    /*  ================================================================  */
    /*  App server functions (main app logic here).                       */
    /*  ================================================================  */

    /**
     *  Create the routing table entries + handlers for the application.
     */
    self.createRoutes = function(app) {

        // app.get('/asciimo', function(req, res) {
        //     var link = "http://i.imgur.com/kmbjB.png";
        //     res.send("<html><body><img src='" + link + "'></body></html>");
        // });

        app.get('/', function(req, res) {
            res.setHeader('Content-Type', 'text/html');
            res.send(self.cache_get('index.html'));
        });

        function prepareParams(req) {
            var params = req.query;
            return _.mapValues(params, function(value) {
                try {
                    // console.log('test', typeof value, value, JSON.parse(value));
                    return JSON.parse(value);
                } catch (e) {
                    console.log(e);
                    return value;
                }
            })
        }

        app.get('/staticmap', function(req, res) {
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
        // app.options('/webtopdf', cors());
        app.post('/webtopdf', function(req, res) {
            var params = req.body;
            // var params = prepareParams(req);
            console.log('params' + JSON.stringify(params));
            if (params.url) {

                var url = params.url;
                delete params.url;
                // params['load-error-handling'] = 'ignore';
                // params['load-media-error'] = 'ignore';
                params['custom-header-propagation'] = true;
                var headers = params['custom-header'] || [];
                headers.push({
                    name: 'User-Agent',
                    // value:'Mozilla/5.0 (iPad; CPU OS 7_0 like Mac OS X) AppleWebKit/537.51.1 (KHTML, like Gecko) CriOS/30.0.1599.12 Mobile/11A465 Safari/8536.25 (3B92C18B-D9DE-4CB7-A02A-22FD2AF17C8F)'
                    value: req.headers['user-agent']
                });
                params['custom-header'] = headers;
                wkhtmltopdf(url, params, function(err, data) {
                    if (!err) {
                        // console.log(typeof data);
                        // console.log(data);
                        res.writeHead(200, {
                            'Content-Type': 'application/pdf'
                        });
                        res.end(data); // Send the file data to the browser.
                    } else {
                        res.status(500).send(err);
                    }
                });
            } else {
                res.status(500).send({
                    error: 'Missing url param'
                });
            }
            // res.send(params);

        });
    };

    /**
     *  Initialize the server (express) and create the routes and register
     *  the handlers.
     */
    self.initializeServer = function() {
        self.app = express.createServer();
        self.app.use(bodyParser.json()); // support json encoded bodies
        self.app.use(bodyParser.urlencoded({
            extended: true
        })); // support encoded bodies
        self.app.use(express.json()); // to support JSON-encoded bodies
        self.app.use(express.urlencoded()); // to support URL-encoded bodies

        self.createRoutes(self.app);
    };

    /**
     *  Initializes the sample application.
     */
    self.initialize = function() {
        self.setupVariables();
        self.populateCache();
        self.setupTerminationHandlers();

        // Create the express server and routes.
        self.initializeServer();
    };

    /**
     *  Start the server (starts up the sample application).
     */
    self.start = function() {
        //  Start the app on the specific interface (and port).
        self.app.listen(self.port, self.ipaddress, function() {
            console.log('%s: Node server started on %s:%d ...',
                Date(Date.now()), self.ipaddress, self.port);
        });
    };

}; /*  Sample Application.  */

/**
 *  main():  Main code.
 */
var zapp = new SampleApp();
zapp.initialize();
zapp.start();