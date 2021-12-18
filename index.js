/* eslint-disable*/
'use strict';
const path = require('path');
const util = require('./util');
const stringify = require('json-stringify-pretty-compact');
const filenamify = require('filenamify');
const urlParse = require('url-parse');
const objectHash = require('object-hash');
const isEqualWith = require('lodash.isequalwith');

const guidGenerator = util.guidGenerator;
const sizeInMbytes = util.sizeInMbytes;
const tryToParseJSON = util.tryToParseJSON;
const prettyObject = util.prettyObject;

const cypressConfig = Cypress.config('autorecord') || {};
const isCleanMocks = cypressConfig.cleanMocks || false;
const includeParentTestName = cypressConfig.includeParentTestName || true;
const separateMockFiles = cypressConfig.separateMockFiles || false;
const isForceRecord = cypressConfig.forceRecord || false;
const recordTests = cypressConfig.recordTests || [];
const blacklistRoutes = cypressConfig.blacklistRoutes || [];
const whitelistHeaders = cypressConfig.whitelistHeaders || [];
const ignoredRequestBodyAttributes = cypressConfig.ignoredRequestBodyAttributes || [];
const stringifyOptions = cypressConfig.stringifyOptions || {};
const isDebug = cypressConfig.debug || false;

let interceptPattern = cypressConfig.interceptPattern || '*';
const interceptPatternFragments = interceptPattern.match(/\/(.*?)\/([a-z]*)?$/i);
if (interceptPatternFragments) {
    interceptPattern = new RegExp(interceptPatternFragments[1], interceptPatternFragments[2] || '');
}

const supportedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const supportedMethodsRegex = /GET|POST|PUT|DELETE|PATCH|HEAD/;

const fileName = path.basename(Cypress.spec.name, path.extname(Cypress.spec.name));

// The replace fixes Windows path handling
const fixturesFolder = Cypress.config('fixturesFolder').replace(/\\/g, '/');
const mocksFolder = path.join(fixturesFolder, '../mocks');

before(function () {
    if (isCleanMocks) {
        cy.task('cleanMocks');
    }

    if (isForceRecord) {
        cy.task('removeAllMocks');
    }
});

function getParentsName(test) {
    if (test.parent && test.parent.title) {
        const grandParentTitle = getParentsName(test.parent);
        const parentTitle = test.parent.title;

        if (grandParentTitle) {
            return `${grandParentTitle}${parentTitle} > `;
        }

        return `${parentTitle} > `;
    }

    return '';
}

function isFixtureUsedInOtherTest(fixturesByTestId, route, currentTitle) {
    const keyAsProp = Object.entries(fixturesByTestId).map(([key, values]) =>
        values.map((value) => ({ key, fixtureId: value }))
    );

    const sameRouteWithThisFixtureId = keyAsProp.find((internalRoutes) =>
        internalRoutes.find(
            (internalRoute) =>
                internalRoute.key !== currentTitle && internalRoute.fixtureId === route.fixtureId
        )
    );

    if (sameRouteWithThisFixtureId) {
        return sameRouteWithThisFixtureId[0];
    }
}

function requestBodyComparator(reqValue, mockValue, key) {
    if (ignoredRequestBodyAttributes.includes(key)) {
        return true;
    }
    return undefined;
}

function isRequestBodyEqual(current, mock) {
    if (!current || !mock) {
        return true;
    }
    return isEqualWith(tryToParseJSON(current), tryToParseJSON(mock), requestBodyComparator);
}

function getAllSpecsFixturesByTestId(routesByTestId) {
    const response = {};

    function pushFixturesByTestId(data) {
        Object.entries(data).forEach(([testId, mocks]) => {
            if (!response[testId]) {
                response[testId] = [];
            }
            response[testId].push(...mocks.map((mock) => mock.fixtureId));
        });
    }

    pushFixturesByTestId(routesByTestId);

    cy.task('readdir', mocksFolder).then((files) => {
        files.forEach((file) => {
            if (file !== `${fileName}.json`) {
                cy.task('readFile', path.join(mocksFolder, file)).then((data) => {
                    pushFixturesByTestId(data);
                });
            }
        });
    });

    return response;
}

module.exports = function autoRecord() {
    const whitelistHeaderRegexes = whitelistHeaders.map((str) => RegExp(str));

    // For cleaning, to store the test names that are active per file
    let testNames = [];
    // For cleaning, to store the clean mocks per file
    let cleanMockData = {};
    // Locally stores all mock data for this spec file
    let routesByTestId = {};
    // Locally stores all specs fixtures by id's
    let allSpecsFixturesByTestId = {};
    // For recording, stores data recorded from hitting the real endpoints
    let routes = [];
    // Stores any fixtures that need to be added
    let addFixture = {};
    // Stores any fixtures that need to be removed
    let removeFixture = [];
    // For force recording, check to see if [r] is present in the test title
    let isTestForceRecord = false;
    // Are there any failed test attempts on this run
    let isTestRetry = false;
    // For debugging purposes
    let log = [];

    before(function () {
        // Get mock data that relates to this spec file
        cy.task('readFile', path.join(mocksFolder, `${fileName}.json`)).then((data) => {
            routesByTestId = data === null ? {} : data;
        });
    });

    beforeEach(function () {
        // Reset routes before each test case
        routes = [];
        log = [];
        isTestRetry = this.currentTest.prevAttempts?.length > 0;

        if (!isTestRetry && includeParentTestName) {
            this.currentTest.title = `${getParentsName(this.currentTest)}${this.currentTest.title}`;
        }
        if (!isTestRetry) {
            isTestForceRecord = this.currentTest.title.includes('[r]');
        }
        if (!isTestRetry && isTestForceRecord) {
            this.currentTest.title = this.currentTest.title.replaceAll('[r]', '');
        }
        if (isTestRetry) {
            this.currentTest.title = this.currentTest.prevAttempts[0].title;
        }

        // Load stubbed data from local JSON file
        // Do not stub if...
        // This test is being force recorded
        // there are no mock data for this test
        if (
            !recordTests.includes(this.currentTest.title) &&
            !isTestForceRecord &&
            routesByTestId[this.currentTest.title]
        ) {
            // This is used to group routes by method type and url (e.g. { GET: { '/api/messages': {...} }})
            const sortedRoutes = {};
            supportedMethods.forEach((method) => {
                sortedRoutes[method] = {};
            });

            routesByTestId[this.currentTest.title].forEach((request) => {
                if (!sortedRoutes[request.method][request.url]) {
                    sortedRoutes[request.method][request.url] = [];
                }

                sortedRoutes[request.method][request.url].push(request);
            });

            // Avoid timed out requests to fail test
            Cypress.on('uncaught:exception', (err) => {
                if (/request failed with status code 408/i.test(err.message)) {
                    return false;
                }
            });

            cy.intercept({ method: supportedMethodsRegex, url: interceptPattern }, (req) => {
                const mocksByUrl = sortedRoutes[req.method][req.url] || [];

                const mock = mocksByUrl.find((mockByUrl) => {
                    return isRequestBodyEqual(req.body, mockByUrl?.body);
                });

                if (isDebug) {
                    log.push({ msg: `\nRequest: ${req.method} ${req.url}`, level: 'data' });
                    if (mock) {
                        log.push({ msg: `Mock: ${prettyObject(mock)}`, level: 'info' });
                    }
                    if (!mock) {
                        log.push({
                            msg: 'No mock found matching this request method, url and body.',
                            level: 'warn',
                        });
                    }
                    if (!mock && mocksByUrl.length > 0) {
                        log.push({
                            msg: [
                                `Request body: ${prettyObject(req.body)}`,
                                `Mocks with matching request method and url: ${mocksByUrl.map((m) =>
                                    prettyObject(m)
                                )}`,
                            ].join('\n'),
                            level: 'warn',
                        });
                    }
                }

                if (mock) {
                    return req.reply({
                        headers: mock.headers,
                        statusCode: mock.status,
                        ...(mock.fixtureId
                            ? { fixture: `${mock.fixtureId}.json` }
                            : { body: mock.response }),
                    });
                }

                // Force unrecognized requests to timeout (e.g. canceled or new requests)
                req.alias = 'autorecordForced408';
                req.reply({
                    statusCode: 408,
                    body: 'cypress-autorecord forced 408 Request Timeout',
                });
            }).as('autorecordStub');
        } else {
            cy.intercept({ method: supportedMethodsRegex, url: interceptPattern }, (req) => {
                // This is cypress loading the page
                if (Object.keys(req.headers).some((k) => k === 'x-cypress-authorization')) {
                    return;
                }
                if (blacklistRoutes.some((route) => req.url.includes(route))) {
                    return;
                }

                req.on('response', (res) => {
                    const url = req.url;
                    const status = res.statusCode;
                    const method = req.method;
                    const data =
                        res.body.constructor.name === 'Blob' ? blobToPlain(res.body) : res.body;
                    const body = req.body;
                    const headers = Object.entries(res.headers)
                        .filter(([key]) => whitelistHeaderRegexes.some((regex) => regex.test(key)))
                        .reduce((obj, [key, value]) => ({ ...obj, [key]: value }), {});

                    // We push a new entry into the routes array
                    // Do not rerecord duplicate requests
                    if (
                        !routes.some(
                            (route) =>
                                route.url === url && route.body === body && route.method === method
                        )
                    ) {
                        routes.push({ url, method, status, data, body, headers });
                    }
                });
            }).as('autorecord');
        }

        // Store test name if isCleanMocks is true
        if (isCleanMocks) {
            testNames.push(this.currentTest.title);
        }
    });

    afterEach(function () {
        log.forEach((params) => {
            cy.task('log', params);
        });

        // Check to see if the current test already has mock data or if forceRecord is on
        if (
            (!routesByTestId[this.currentTest.title] ||
                isTestForceRecord ||
                recordTests.includes(this.currentTest.title)) &&
            !isCleanMocks
        ) {
            // Construct endpoint to be saved locally
            const endpoints = routes.map((request) => {
                // Check to see of mock data is too large for request header
                const isFileOversized = sizeInMbytes(request.data) > 70;

                let fixtureId;

                const { url, method, status } = request;

                // If the mock data is too large, store it in a separate json
                if (isFileOversized) {
                    fixtureId = guidGenerator();
                }

                if (separateMockFiles) {
                    const parsed = urlParse(url);
                    const subFolder = filenamify(parsed.hostname);
                    const name = `${filenamify(parsed.pathname.replace(/,/gi, ''))}_${filenamify(
                        parsed.query
                    )}`;

                    fixtureId = `${subFolder}/${name}_${method}_${status}`;

                    // Everything except get should have unique responses
                    // minimize generated files by assuming that same request body produces same result
                    if (method !== 'GET') {
                        const requestHash = objectHash(request.body);
                        const responseHash = objectHash(request.data);
                        fixtureId = `${fixtureId}_${requestHash}_${responseHash}`;
                    }
                }

                if (fixtureId) {
                    addFixture[path.join(fixturesFolder, `${fixtureId}.json`)] = stringify(
                        request.data,
                        stringifyOptions
                    );
                }

                return {
                    fixtureId: fixtureId,
                    url,
                    method,
                    status,
                    headers: request.headers,
                    body: request.body,
                    response: isFileOversized || separateMockFiles ? undefined : request.data,
                };
            });

            // Delete fixtures if we are overwriting mock data
            if (routesByTestId[this.currentTest.title]) {
                if (Object.keys(allSpecsFixturesByTestId).length === 0) {
                    allSpecsFixturesByTestId = getAllSpecsFixturesByTestId(routesByTestId);
                }

                routesByTestId[this.currentTest.title].forEach((route) => {
                    // If fixtureId exist, delete the json

                    if (route.fixtureId) {
                        const sameRouteWithThisFixtureId = isFixtureUsedInOtherTest(
                            allSpecsFixturesByTestId,
                            route,
                            this.currentTest.title
                        );

                        if (!sameRouteWithThisFixtureId) {
                            removeFixture.push(
                                path.join(fixturesFolder, `${route.fixtureId}.json`)
                            );
                        } else {
                            console.warn(
                                `${route.fixtureId} is used in "${sameRouteWithThisFixtureId.key}", not deleting`
                            );
                        }
                    }
                });
            }

            // Store the endpoint for this test in the mock data object for this file if there are endpoints for this test
            if (endpoints.length > 0) {
                routesByTestId[this.currentTest.title] = endpoints;
            }
        }
    });

    after(function () {
        // Transfer used mock data to new object to be stored locally
        if (isCleanMocks) {
            Object.keys(routesByTestId).forEach((testName) => {
                if (testNames.includes(testName)) {
                    cleanMockData[testName] = routesByTestId[testName];
                } else {
                    routesByTestId[testName].forEach((route) => {
                        if (route.fixtureId) {
                            cy.task(
                                'deleteFile',
                                path.join(fixturesFolder, `${route.fixtureId}.json`)
                            );
                        }
                    });
                }
            });
        }

        removeFixture.forEach((fixtureName) => cy.task('deleteFile', fixtureName));

        const data = isCleanMocks ? cleanMockData : routesByTestId;

        cy.writeFile(
            path.join(mocksFolder, `${fileName}.json`),
            stringify(data, stringifyOptions)
            // prettier.format(JSON.stringify(data), { parser: 'html', plugins: [prettierReact] })
        );
        Object.keys(addFixture).forEach((fixtureName) => {
            cy.writeFile(fixtureName, addFixture[fixtureName]);
        });
    });
};
