"use strict";

const isTV = typeof tizen !== 'undefined';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; process.removeAllListeners('warning');

module.exports.onStart = function () { console.log('Service started');

const express = require('express');
const fetch = require('node-fetch');
const adbhost = require('adbhost');
const { readConfig, writeConfig } = require('./utils/configuration.js');
const { fetchLatestRelease } = require('./utils/GitHubAPI.js');
const { createSamsungCertificate, resignPackage } = require('./utils/SamsungCertificateCreation.js');
const {
    writeFileSync,
    readFileSync,
    readdirSync,
    statSync,
    mkdirSync,
    existsSync
} = require('fs');

const { setValue } = require('./utils/Buxton2.js');
const { join, dirname, resolve } = require('path');
const { parsePackage, installPackage } = require('./utils/PackageInstallation.js');
const { Connection, Events } = require('./utils/wsCommunication.js');
const { homedir } = require('os');
const AccessInfoHTMLPage = require('./utils/HTMLPage.js');
const PushFile = require('./utils/FilePusher.js');

let WebSocket;
let adbClient = null;
let wsClient = null;
let canConnectToDevice = null;
let isConnected = false;

if (process.version === 'v4.4.3') {
    WebSocket = require('ws-old');
} else {
    WebSocket = require('ws-new');
}

const app = express();

// --------------------------------------------------
// FRONTEND PATH RESOLUTION
// --------------------------------------------------

const frontendCandidates = [
    resolve(process.cwd(), '../../ui'),
    resolve(__dirname, '../../../ui'),
    resolve(__dirname, '../../ui'),
    resolve(process.cwd(), 'ui')
];

const frontendRoot = frontendCandidates.find(candidate =>
    existsSync(join(candidate, 'dist', 'index.html'))
);

if (!isTV) {
    if (!frontendRoot) {
        console.error('Frontend directory not found.');
        console.error('Searched:', frontendCandidates);
    } else {
        console.log('Frontend directory:', frontendRoot);
        console.log('Frontend HTML:', join(frontendRoot, 'dist', 'index.html'));

        // Serve /ui/dist/index.html and all frontend assets.
        app.use('/ui', express.static(frontendRoot, {
            index: false,
            fallthrough: true
        }));

        // Serve the frontend directly.
        app.get('/ui/dist/index.html', (req, res) => {
            res.sendFile(join(frontendRoot, 'dist', 'index.html'));
        });

        // Optional root redirect.
        app.get('/', (req, res) => {
            res.redirect('/ui/dist/index.html');
        });

        console.log('Frontend URL: http://localhost:8091/ui/dist/index.html');
    }
}

app.get('/ui/dist/index.html/desktop', (req, res) => {
    if (frontendRoot) {
        return res.sendFile(join(frontendRoot, 'dist', 'index.html'));
    }

    res.status(404).send('Frontend not found.');
});

// --------------------------------------------------
// TIZEN INFORMATION
// --------------------------------------------------

let isTizen7OrHigher = isTV &&
    Number(
        tizen.systeminfo.getCapability(
            'http://tizen.org/feature/platform.version'
        ).split('.')[0]
    ) >= 7;

const isTizen3 = isTV &&
    tizen.systeminfo.getCapability(
        'http://tizen.org/feature/platform.version'
    ).startsWith('3.0');

const server = app.listen(8091, () => {
    console.log('HTTP server listening on port 8091');
});

const wsServer = new WebSocket.Server({ server });

// --------------------------------------------------
// DEBUG MODE CHECK
// --------------------------------------------------

function checkCanConnectToDevice() {
    fetch('http://127.0.0.1:8001/api/v2/')
        .then(res => res.json())
        .then(json => {
            canConnectToDevice =
                (
                    json.device.developerIP === '127.0.0.1' ||
                    json.device.developerIP === '1.0.0.127'
                ) &&
                json.device.developerMode === '1';
        })
        .catch(() => {
            setTimeout(checkCanConnectToDevice, 1000);
        });
}

if (isTV) {
    checkCanConnectToDevice();
}

// --------------------------------------------------
// ADB / SDB CONNECTION
// --------------------------------------------------

function createAdbConnection(ip) {
    return new Promise((resolveConnection, reject) => {
        try {
            if (adbClient && adbClient._stream) {
                adbClient._stream.removeAllListeners('connect');
                adbClient._stream.removeAllListeners('error');
                adbClient._stream.removeAllListeners('close');
                adbClient._stream.destroy();
            }

            const client = adbhost.createConnection({
                host: ip || '127.0.0.1',
                port: 26101
            });

            adbClient = client;

            let hasConnected = false;
            let settled = false;

            const waitTimeout = setTimeout(() => {
                if (hasConnected && !settled) {
                    settled = true;
                    resolveConnection(client);
                }
            }, 1000);

            client._stream.on('connect', () => {
                hasConnected = true;
                isConnected = true;

                if (isTV && !settled) {
                    settled = true;
                    clearTimeout(waitTimeout);
                    resolveConnection(client);
                }
            });

            client._stream.on('error', (e) => {
                if (settled) return;

                settled = true;
                adbClient = null;
                isConnected = false;
                clearTimeout(waitTimeout);

                if (e.code === 'ECONNREFUSED') {
                    reject(new Error('installerDesktop.sdbConnectionRefused'));
                } else if (e.code === 'ECONNRESET') {
                    reject(new Error('installerDesktop.sdbConnectionReset'));
                } else {
                    reject(new Error('ADB connection error: ' + e.message));
                }
            });

            client._stream.on('close', () => {
                adbClient = null;
                isConnected = false;
                clearTimeout(waitTimeout);

                if (!settled) {
                    settled = true;
                    reject(new Error('ADB connection closed.'));
                }
            });

        } catch (e) {
            reject(new Error('ADB connection error: ' + e.message));
        }
    });
}

// --------------------------------------------------
// DIRECTORY UTILITIES
// --------------------------------------------------

function mkdirRecursive(targetDir) {
    if (existsSync(targetDir)) return;

    const parent = dirname(targetDir);

    if (!existsSync(parent)) {
        mkdirRecursive(parent);
    }

    mkdirSync(targetDir);
}

// --------------------------------------------------
// WEBSOCKET
// --------------------------------------------------

wsServer.on('connection', (ws) => {
    const wsConn = new Connection(ws);
    wsClient = wsConn;

    ws.on('message', (message) => {
        let msg;

        try {
            msg = JSON.parse(message);
        } catch (e) {
            return wsConn.send(
                wsConn.Event(Events.Error, `Invalid JSON: ${message}`)
            );
        }

        const { type, payload } = msg;

        // --------------------------------------------------
        // PACKAGE PARSING AND INSTALLATION
        // --------------------------------------------------

        function parseAndInstall(buffer) {
            parsePackage(buffer)
                .then(pkg => {
                    wsConn.send(
                        wsConn.Event(
                            Events.InstallationStatus,
                            'installStatus.installing'
                        )
                    );

                    if (isTV) {
                        if (!existsSync('/home/owner/share/tmp/sdk_tools')) {
                            mkdirRecursive('/home/owner/share/tmp/sdk_tools');
                        }

                        writeFileSync(
                            `/home/owner/share/tmp/sdk_tools/package.${pkg.isWgt ? 'wgt' : 'tpk'}`,
                            buffer
                        );
                    } else {
                        PushFile(
                            adbClient,
                            `/home/owner/share/tmp/sdk_tools/package.${pkg.isWgt ? 'wgt' : 'tpk'}`,
                            buffer,
                            () => {
                                installPackage(
                                    `/home/owner/share/tmp/sdk_tools/package.${pkg.isWgt ? 'wgt' : 'tpk'}`,
                                    pkg.packageId,
                                    adbClient
                                )
                                    .then(result => {
                                        wsConn.send(
                                            wsConn.Event(
                                                Events.InstallationStatus,
                                                'installStatus.installed'
                                            )
                                        );

                                        wsConn.send(
                                            wsConn.Event(
                                                Events.InstallPackage,
                                                { response: 0, result }
                                            )
                                        );
                                    })
                                    .catch(err => {
                                        wsConn.send(
                                            wsConn.Event(
                                                Events.Error,
                                                `Installation failed: ${err.message}`
                                            )
                                        );
                                    });
                            }
                        );

                        return;
                    }

                    if (isTizen3 && isTV) {
                        const result = installPackage(
                            `/home/owner/share/tmp/sdk_tools/package.${pkg.isWgt ? 'wgt' : 'tpk'}`,
                            pkg.packageId
                        );

                        setValue('db/sdk/develop/ip', 'string', '127.0.0.1');
                        setValue('db/sdk/develop/mode', 'int32', '1');

                        wsConn.send(
                            wsConn.Event(
                                Events.InstallationStatus,
                                'installStatus.installed'
                            )
                        );

                        wsConn.send(
                            wsConn.Event(
                                Events.InstallPackage,
                                { response: 0, result }
                            )
                        );

                    } else if (isTV) {
                        createAdbConnection()
                            .then(client => {
                                installPackage(
                                    `/home/owner/share/tmp/sdk_tools/package.${pkg.isWgt ? 'wgt' : 'tpk'}`,
                                    pkg.packageId,
                                    client
                                )
                                    .then(result => {
                                        wsConn.send(
                                            wsConn.Event(
                                                Events.InstallationStatus,
                                                'installStatus.installed'
                                            )
                                        );

                                        wsConn.send(
                                            wsConn.Event(
                                                Events.InstallPackage,
                                                { response: 0, result }
                                            )
                                        );

                                        setTimeout(() => {
                                            client._stream.end();
                                            client._stream.destroy();
                                        }, 5000);
                                    })
                                    .catch(err => {
                                        wsConn.send(
                                            wsConn.Event(
                                                Events.Error,
                                                `Installation failed: ${err.message}`
                                            )
                                        );
                                    });
                            })
                            .catch(err => {
                                wsConn.send(
                                    wsConn.Event(
                                        Events.Error,
                                        err.message
                                    )
                                );
                            });
                    }
                })
                .catch(err => {
                    wsConn.send(
                        wsConn.Event(
                            Events.Error,
                            `Error parsing package: ${err.message}`
                        )
                    );

                    console.error(err);
                });
        }

        // --------------------------------------------------
        // CERTIFICATE RESIGNING
        // --------------------------------------------------

        function resignOrInstall(buffer) {
            if (isTizen7OrHigher) {
                const config = readConfig();

                const certificates = {
                    authorCert: Buffer.from(
                        config.authorCert,
                        'base64'
                    ).toString('binary'),

                    distributorCert: Buffer.from(
                        config.distributorCert,
                        'base64'
                    ).toString('binary'),

                    password: config.password
                };

                wsConn.send(
                    wsConn.Event(
                        Events.InstallationStatus,
                        'installStatus.resigning'
                    )
                );

                resignPackage(certificates, buffer)
                    .then(resignedBuffer => {
                        wsConn.send(
                            wsConn.Event(
                                Events.InstallationStatus,
                                'installStatus.parsing'
                            )
                        );

                        parseAndInstall(resignedBuffer);
                    })
                    .catch(err => {
                        wsConn.send(
                            wsConn.Event(
                                Events.Error,
                                `Error resigning package: ${err.message}`
                            )
                        );
                    });

            } else {
                wsConn.send(
                    wsConn.Event(
                        Events.InstallationStatus,
                        'installStatus.parsing'
                    )
                );

                parseAndInstall(buffer);
            }
        }

        // --------------------------------------------------
        // PRECONDITION CHECK
        // --------------------------------------------------

        function checkPrecondition() {
            if (!isTizen3 && isTV) {
                if (
                    canConnectToDevice !== null &&
                    !canConnectToDevice
                ) {
                    wsConn.send(
                        wsConn.Event(
                            Events.Error,
                            'errors.debuggingNotEnabled'
                        )
                    );

                    return false;
                }

                if (canConnectToDevice === null) {
                    return false;
                }
            }

            if (isTizen7OrHigher) {
                const config = readConfig();

                if (
                    !config.authorCert ||
                    !config.distributorCert ||
                    !config.password
                ) {
                    wsConn.send(
                        wsConn.Event(
                            Events.InstallPackage,
                            { response: 2 }
                        )
                    );

                    return false;
                }
            }

            if (!isTV && (!adbClient || !isConnected)) {
                wsConn.send(
                    wsConn.Event(
                        Events.ConnectToTV,
                        { success: false }
                    )
                );

                return false;
            }

            return true;
        }

        // --------------------------------------------------
        // EVENT HANDLING
        // --------------------------------------------------

        switch (type) {

            case Events.InstallPackage: {
                if (!checkPrecondition()) return;

                if (payload.url.split('/').length === 2) {
                    wsConn.send(
                        wsConn.Event(
                            Events.InstallationStatus,
                            'installStatus.fetching'
                        )
                    );

                    fetchLatestRelease(payload.url)
                        .then(release => {
                            const asset = release.assets.find(
                                a =>
                                    a.name.endsWith('.wgt') ||
                                    a.name.endsWith('.tpk')
                            );

                            if (!asset) {
                                throw new Error('No WGT or TPK asset found.');
                            }

                            return fetch(asset.browser_download_url);
                        })
                        .then(res => {
                            if (!res.ok) {
                                throw new Error(`HTTP ${res.status}`);
                            }

                            return res.buffer();
                        })
                        .then(buffer => {
                            resignOrInstall(buffer);
                        })
                        .catch(err => {
                            wsConn.send(
                                wsConn.Event(
                                    Events.Error,
                                    `Error fetching package: ${err.message}`
                                )
                            );
                        });

                } else {
                    try {
                        const fileBuffer = readFileSync(payload.url);
                        resignOrInstall(fileBuffer);
                    } catch (err) {
                        wsConn.send(
                            wsConn.Event(
                                Events.Error,
                                `Error reading package: ${err.message}`
                            )
                        );
                    }
                }

                break;
            }

            case Events.NavigateDirectory: {
                try {
                    const directory = readdirSync(payload);

                    const metadata = [{
                        name: 'Go up one directory',
                        path: payload !== '/media'
                            ? join(payload, '..')
                            : '/media',
                        isDirectory: true
                    }];

                    for (const file of directory) {
                        const filePath = join(payload, file);

                        try {
                            const stats = statSync(filePath);

                            metadata.push({
                                name: file,
                                path: filePath,
                                isDirectory: stats.isDirectory()
                            });
                        } catch (e) { }
                    }

                    wsConn.send(
                        wsConn.Event(
                            Events.NavigateDirectory,
                            metadata
                        )
                    );
                } catch (err) {
                    wsConn.send(
                        wsConn.Event(
                            Events.Error,
                            `Directory error: ${err.message}`
                        )
                    );
                }

                break;
            }

            case Events.InstallFile: {
                if (!checkPrecondition()) return;

                const fileBuffer = Buffer.from(payload, 'base64');
                resignOrInstall(fileBuffer);

                break;
            }

            case Events.DeleteConfiguration: {
                const config = readConfig();

                config.authorCert = null;
                config.distributorCert = null;
                config.password = null;

                writeConfig(config);

                wsConn.send(
                    wsConn.Event(
                        Events.DeleteConfiguration,
                        null
                    )
                );

                break;
            }

            case Events.ConnectToTV: {
                createAdbConnection(payload)
                    .then(client => {
                        adbClient = client;

                        wsConn.send(
                            wsConn.Event(
                                Events.ConnectToTV,
                                { success: true }
                            )
                        );

                        const sysinfoCommand = client.createStream('sysinfo:');

                        sysinfoCommand.on('data', data => {
                            const INFOBUF_MAXLEN = 64;

                            const platformVersion = data
                                .slice(
                                    INFOBUF_MAXLEN * 3,
                                    INFOBUF_MAXLEN * 4
                                )
                                .toString()
                                .replace(/\0/g, '');

                            isTizen7OrHigher =
                                Number(platformVersion.split('.')[0]) >= 7;
                        });
                    })
                    .catch(err => {
                        wsConn.send(
                            wsConn.Event(
                                Events.ConnectToTV,
                                {
                                    success: false,
                                    error: err.message
                                }
                            )
                        );
                    });

                break;
            }

            default: {
                wsConn.send(
                    wsConn.Event(
                        Events.Error,
                        'Invalid event type.'
                    )
                );

                break;
            }
        }
    });
});

// --------------------------------------------------
// SAMSUNG CERTIFICATE ACCESS SERVER
// --------------------------------------------------

const appAccess = express();

appAccess.use(express.urlencoded({ extended: false }));

appAccess.use((request, response) => {
    if (request.method === 'GET') {
        return response.send(AccessInfoHTMLPage);
    }

    try {
        const body = JSON.parse(request.body.code);

        const accessInfo = {
            accessToken: body.access_token,
            userId: body.userId
        };

        const password =
            Math.random().toString(36).slice(-10) +
            Math.random().toString(36).slice(-10) +
            Math.random().toString(36).slice(-4);

        const authorInfo = {
            name: 'TizenBrew',
            email: body.inputEmailID,
            password,
            privilegeLevel: 'Partner'
        };

        function createCert() {
            createSamsungCertificate(
                authorInfo,
                accessInfo,
                adbClient,
                isTV
            )
                .then(certificate => {
                    const currentConfig = readConfig();

                    currentConfig.authorCert = Buffer.from(
                        certificate.authorCert,
                        'binary'
                    ).toString('base64');

                    currentConfig.distributorCert = Buffer.from(
                        certificate.distributorCert,
                        'binary'
                    ).toString('base64');

                    currentConfig.password = password;

                    if (isTV) {
                        if (!existsSync('/home/owner/share/tmp/sdk_tools')) {
                            mkdirRecursive('/home/owner/share/tmp/sdk_tools');
                        }

                        writeFileSync(
                            '/home/owner/share/tmp/sdk_tools/device-profile.xml',
                            certificate.distributorXML
                        );
                    } else {
                        PushFile(
                            adbClient,
                            '/home/owner/share/tmp/sdk_tools/device-profile.xml',
                            Buffer.from(
                                certificate.distributorXML,
                                'utf8'
                            ),
                            () => {
                                console.log('Device profile pushed to TV');
                            }
                        );
                    }

                    writeConfig(currentConfig);

                    if (wsClient) {
                        wsClient.send(
                            wsClient.Event(
                                Events.InstallPackage,
                                { response: 1 }
                            )
                        );
                    }

                    response.status(200).send(
                        'Certificate creation was successful. You can now close this window.'
                    );
                })
                .catch(err => {
                    response.status(500).json({
                        error: err.message
                    });
                });
        }

        if (isTV) {
            if (!adbClient && !isConnected) {
                createAdbConnection()
                    .then(() => createCert())
                    .catch(err => {
                        response.status(500).json({
                            error: err.message
                        });
                    });
            } else {
                createCert();
            }

        } else if (!adbClient || !isConnected) {
            response.send(
                'Connection between the TV and the device was broken. Please reconnect to your TV from the previous page and try again.'
            );

            if (wsClient) {
                wsClient.send(
                    wsClient.Event(
                        Events.ConnectToTV,
                        { success: false }
                    )
                );
            }

        } else {
            createCert();
        }

    } catch (err) {
        response.status(400).json({
            error: err.message
        });
    }
});

appAccess.listen(4794, () => {
    console.log('Certificate server listening on port 4794');
});


};

!isTV && module.exports.onStart();
