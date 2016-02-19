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
// var mod_spawnasync = require('spawn-async');
var concat = require('concat-stream');
var bodyParser = require('body-parser');
var log = new mod_bunyan({
    'name': mod_path.basename(process.argv[1]),
    'level': process.env['LOG_LEVEL'] || 'debug'
});
// var wkhtmltopdf = require('wkhtmltopdf');
wkhtmltopdfcommand = './bin/linux/' + 'wkhtmltopdf'
if (os.platform() == 'darwin') {
    wkhtmltopdfcommand = './bin/osx/' + 'wkhtmltopdf'
        // } else {
        // wkhtmltopdf.command = './bin/linux/' + 'wkhtmltopdf'
}

function quote(val) {
    // escape and quote the value if it is a string and this isn't windows
    if (typeof val === 'string')
        val = '"' + val.replace(/(["\\$`])/g, '\\$1') + '"';

    return val;
}

function wkhtmltopdf(url, params, callback) {
    callback = callback || Function.prototype
    var args = [wkhtmltopdfcommand, '--quiet'];
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
    console.log("call made is::", "/bin/sh", ["-c", args.join(' ')]);
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
    var child = spawn('/bin/sh', ['-c', args.join(' ')], {
        stdio: ['pipe', 'pipe', 'pipe']
    });
    // setup error handling
    var stream = child.stderr;

    function handleError(err) {
        if (debug) {
            console.log('handleError()');
            console.log(err);
        }

        child.removeAllListeners('exit');
        child.kill();

        callback(new Error(err));
    }

    stream.on('error', handleError);

    var write = concat(function(data) {
        callback(null, data);
    });

    child.stdout.pipe(write);
    return stream;
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
        app.post('/webtopdf', function(req, res) {
            var params = req.body;
            console.log('params' + JSON.stringify(params));
            if (params.url) {

                var url = params.url;
                delete params.url;
                params['custom-header-propagation'] = true;
                var headers = params['custom-header'] || [];
                headers.push({
                    name:'User-Agent', 
                    // value:'Mozilla/5.0 (iPad; CPU OS 7_0 like Mac OS X) AppleWebKit/537.51.1 (KHTML, like Gecko) CriOS/30.0.1599.12 Mobile/11A465 Safari/8536.25 (3B92C18B-D9DE-4CB7-A02A-22FD2AF17C8F)'
                    value:req.headers['user-agent']
                });
                params['custom-header'] = headers;
                wkhtmltopdf(url, params, function(err, data) {
                    if (!err) {
                        res.send(data);
                    } else {
                        res.status(500).send(err);
                    }
                });
            } else {
                res.status(500).send({ error: 'Missing url param' });
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