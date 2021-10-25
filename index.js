/* eslint-disable*/
'use strict';
const path = require('path');
const util = require('./util');
const stringify = require('json-stringify-pretty-compact');
const filenamify = require('filenamify');
const urlParse = require('url-parse');
const objectHash = require('object-hash');

const guidGenerator = util.guidGenerator;
const sizeInMbytes = util.sizeInMbytes;

const cypressConfig = Cypress.config('autorecord') || {};
const isCleanMocks = cypressConfig.cleanMocks || false;
const includeParentTestName = cypressConfig.includeParentTestName || true;
const seperateMockFiles = cypressConfig.seperateMockFiles || false;
const isForceRecord = cypressConfig.forceRecord || false;
const recordTests = cypressConfig.recordTests || [];
const blacklistRoutes = cypressConfig.blacklistRoutes || [];
const whitelistHeaders = cypressConfig.whitelistHeaders || [];
const supportedMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];

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

    return;
}

function isFixtureUsedInOtherTest(routesByTestId, route, currentTitle) {
    const keyAsProp = Object.entries(routesByTestId).map(([key, values]) =>
        values.map((value) => ({ key, ...value }))
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

module.exports = function autoRecord() {
    const whitelistHeaderRegexes = whitelistHeaders.map((str) => RegExp(str));

    // For cleaning, to store the test names that are active per file
    let testNames = [];
    // For cleaning, to store the clean mocks per file
    let cleanMockData = {};
    // Locally stores all mock data for this spec file
    let routesByTestId = {};
    // For recording, stores data recorded from hitting the real endpoints
    let routes = [];
    // Stores any fixtures that need to be added
    let addFixture = {};
    // Stores any fixtures that need to be removed
    let removeFixture = [];
    // For force recording, check to see if [r] is present in the test title
    let isTestForceRecord = false;

    before(function () {
        // Get mock data that relates to this spec file
        cy.task('readFile', path.join(mocksFolder, `${fileName}.json`)).then((data) => {
            routesByTestId = data === null ? {} : data;
        });
    });

    beforeEach(function () {
        // Reset routes before each test case
        routes = [];

        cy.server({
            // Filter out blacklisted routes from being recorded and logged
            ignore: (xhr) => {
                if (xhr.url) {
                    // TODO: Use blobs
                    return blacklistRoutes.some((route) => xhr.url.includes(route));
                }
            },
            // Here we handle all requests passing through Cypress' server
            onResponse: (response) => {
                const url = response.url;
                const status = response.status;
                const method = response.method;
                const data = response.response.body;
                const body = response.request.body;
                const headers = Object.entries(response.response.headers)
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
            },
            // Disable all routes that are not mocked
            force404: true,
        });

        // check to see if test is being force recorded
        // TODO: change this to regex so it only reads from the beginning of the string
        isTestForceRecord = this.currentTest.title.includes('[r]');

        this.currentTest.title = isTestForceRecord
            ? this.currentTest.title.replace('[r]', '')
            : this.currentTest.title;
        // let's add parent test to test name

        if (includeParentTestName) {
            this.currentTest.title = `${getParentsName(this.currentTest)}${this.currentTest.title}`;
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

            cy.server({
                force404: true,
            });

            routesByTestId[this.currentTest.title].forEach((request) => {
                if (!sortedRoutes[request.method][request.url]) {
                    sortedRoutes[request.method][request.url] = [];
                }

                sortedRoutes[request.method][request.url].push(request);
            });

            const onResponse = (method, url, index) => {
                if (sortedRoutes[method][url].length > index) {
                    const response = sortedRoutes[method][url][index];
                    cy.route({
                        method: response.method,
                        url: url,
                        status: response.status,
                        headers: response.headers,
                        response: response.fixtureId
                            ? `fixture:${response.fixtureId}.json`
                            : response.response,
                        // This handles requests from the same url but with different request bodies
                        // Tip: this causes errors with tests ( this and cy.visit in beforeEach)
                        // If same request but different body is needed in one test, then this should be fixed here.
                        // onResponse: () => onResponse(method, url, index + 1),
                    });
                }
            };

            // Stub all recorded routes
            Object.keys(sortedRoutes).forEach((method) => {
                Object.keys(sortedRoutes[method]).forEach((url) => onResponse(method, url, 0));
            });
        } else {
            // Allow all routes to go through
            cy.server({ force404: false });

            // This tells Cypress to hook into all types of requests
            supportedMethods.forEach((method) => {
                cy.route({
                    method,
                    url: '*',
                });
            });
        }

        // Store test name if isCleanMocks is true
        if (isCleanMocks) {
            testNames.push(this.currentTest.title);
        }
    });

    afterEach(function () {
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

                if (seperateMockFiles) {
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
                        request.data
                    );
                }

                return {
                    fixtureId: fixtureId,
                    url,
                    method,
                    status,
                    headers: request.headers,
                    body: request.body,
                    response: isFileOversized || seperateMockFiles ? undefined : request.data,
                };
            });

            // Delete fixtures if we are overwriting mock data
            if (routesByTestId[this.currentTest.title]) {
                routesByTestId[this.currentTest.title].forEach((route) => {
                    // If fixtureId exist, delete the json
                    if (route.fixtureId) {
                        const sameRouteWithThisFixtureId = isFixtureUsedInOtherTest(
                            routesByTestId,
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
            stringify(data)
            // prettier.format(JSON.stringify(data), { parser: 'html', plugins: [prettierReact] })
        );
        Object.keys(addFixture).forEach((fixtureName) => {
            cy.writeFile(fixtureName, addFixture[fixtureName]);
        });
    });
};
