const path = require('path');
const colors = require('colors/safe');

colors.setTheme({
    info: ['green'],
    warn: ['yellow'],
    error: ['red'],
    data: ['grey'],
    log: ['blue', 'dim'],
    default: [],
});

module.exports = (on, config, fs) => {
    // `on` is used to hook into various events Cypress emits
    // `config` is the resolved Cypress config
    const mocksFolder = path.resolve(config.fixturesFolder, '../mocks');

    const readFile = (filePath) => {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }

        return null;
    };

    const readdir = (folderPath) => {
        if (fs.existsSync(folderPath)) {
            return fs.readdirSync(folderPath);
        }

        return [];
    };

    const deleteFile = (filePath) => {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            return true;
        }

        return null;
    };

    const cleanMocks = () => {
        // TODO: create error handling
        const specFiles = fs.readdirSync(config.integrationFolder);
        const mockFiles = fs.readdirSync(mocksFolder);
        mockFiles.forEach((mockName) => {
            const isMockUsed = specFiles.find(
                (specName) => specName.split('.')[0] === mockName.split('.')[0]
            );
            if (!isMockUsed) {
                const mockData = readFile(path.join(mocksFolder, mockName));
                Object.keys(mockData).forEach((testName) => {
                    mockData[testName].forEach((route) => {
                        if (route.fixtureId) {
                            deleteFile(path.join(config.fixturesFolder, `${route.fixtureId}.json`));
                        }
                    });
                });

                deleteFile(path.join(mocksFolder, mockName));
            }
        });

        return null;
    };

    const removeAllMocks = () => {
        const fixtureFiles = fs.readdirSync(config.fixturesFolder);
        const mockFiles = fs.readdirSync(mocksFolder);

        fixtureFiles.forEach((fileName) => {
            deleteFile(path.join(config.fixturesFolder, fileName));
        });

        mockFiles.forEach((fileName) => {
            deleteFile(path.join(mocksFolder, fileName));
        });

        return null;
    };

    const log = ({ msg, level, params = [] }) => {
        const prefix = colors.log('[autorecord] ');
        const message = `${prefix}${msg}`.split('\n').join(`\n${prefix}`);
        const color = level || 'default';

        console.info(colors[color](message), ...params);

        return null;
    };

    on('task', {
        readFile,
        readdir,
        deleteFile,
        cleanMocks,
        removeAllMocks,
        log,
    });
};
