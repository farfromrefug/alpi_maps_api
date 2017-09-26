var _ = require('lodash');
var slang = require('slang');
var spawn = require('child_process').spawn;
// var Promise = require('bluebird');
var os = require('os');

wkhtmltopdfcommand = './bin/linux/' + 'wkhtmltopdf';
if (os.platform() == 'darwin') {
    wkhtmltopdfcommand = './bin/osx/' + 'wkhtmltopdf'
}

function quote(val) {
    // escape and quote the value if it is a string and this isn't windows
    if (typeof val === 'string')
        val = '"' + val.replace(/(["\\$`])/g, '\\$1') + '"';

    return val;
}

function execute(command, args, options) {
    var cp;
    console.log(command, args.join(' '));
    var promise = new Promise(function(resolve, reject) {
        var stderr = new Buffer('');
        var stdout = new Buffer('');

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
                if (!/Error:/.test(err) && /Exit with code 1 due to network error/.test(err)) {
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

//script to run to make sure all div are expanded. supprots:
// wikipedia / wikimedia
function toRunAfterLoad() {
    if (/wikipedia|wikimedia|wikivoyage/.test(window.location.href)) {
        var classes = ['collapsible-block'],
            elements;
        for (var i = 0; i < classes.length; i++) {
            elements = document.getElementsByClassName(classes[i]);
            for (var j = 0; j < elements.length; j++) {
                elements[j].style.display = 'block';
            }
        }
    }

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

    args.push('--no-stop-slow-scripts');
    args.push('--javascript-delay');
    args.push(100);
    args.push('--run-script');
    args.push('"(' + toRunAfterLoad.toString().replace(/\n|\r/g, '') + ')()"');

    args.push(quote(url)); // stdin if HTML given directly
    args.push('-'); // stdin if HTML given directly

    return execute('/bin/sh', ['-c', args.join(' ') + ' | cat'], {
            // cwd: '~/foo'
        })
        .then(function(io) {
            callback(null, io.stdout);
        }, function(err) {
            console.log('Command failed', err.message, err.status);
            if (err.stderr) {
                console.log(err.stderr.toString());
            }
            callback(new Error(err));
        });
}
module.exports = function(app) {
    app.post('/webtopdf', function(req, res) {
        var params = (typeof req.body === 'string')? JSON.parse(req.body):req.body;
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
}