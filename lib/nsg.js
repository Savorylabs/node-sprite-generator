'use strict';

var Promise = require('bluebird'),
    fs = require('fs'),
    writeFile = Promise.promisify(fs.writeFile),
    readFile = Promise.promisify(fs.readFile),
    glob = Promise.promisify(require('glob')),
    mkdirp = Promise.promisify(require('mkdirp')),
    path = require('path'),
    R = require('ramda'),
    changeDetector = require('./utils/changeDetector'),
    stylesheetUtils = require('./utils/stylesheet'),
    providedLayouts = require('./layout'),
    providedCompositors = require('./compositor'),
    providedStylesheets = require('./stylesheet'),
    isNotNull = R.complement(R.isNil),
    MAX_PARALLEL_FILE_READS = 80,
    defaultOptions = {
        src: [],
        spritePath: null,
        stylesheetPath: null,
        layout: 'vertical',
        stylesheet: 'stylus',
        compositor: 'canvas',
        layoutOptions: {
            padding: 0,
            scaling: 1
        },
        compositorOptions: {
            compressionLevel: 6,
            filter: 'all'
        },
        stylesheetOptions: {
            spritePath: null,
            prefix: '',
            nameMapping: stylesheetUtils.nameToClass,
            pixelRatio: 1
        }
    };

function readAllSources(src) {
    var stringSources = R.filter(R.is(String))(src),
        otherSources = R.difference(src, stringSources);

    return Promise.map(stringSources, R.unary(glob))
        .then(R.flatten)
        .then(R.uniq)
        .map(function (path) {
            return readFile(path).then(R.assoc('data', R.__, { path: path }));
        })
        .then(R.union(otherSources));
}

function generateSprite(userOptions, callback) {
    var options = R.pipe(
            R.merge(defaultOptions),
            R.evolve({
                compositorOptions: R.merge(defaultOptions.compositorOptions),
                layoutOptions: R.merge(defaultOptions.layoutOptions),
                stylesheetOptions: R.merge(defaultOptions.stylesheetOptions)
            }),
            stylesheetUtils.getRelativeSpriteDir
        )(userOptions),
        generateLayout = R.propOr(options.layout, options.layout, providedLayouts),
        compositor = R.propOr(options.compositor, options.compositor, providedCompositors),
        renderStylesheet = R.cond([
            [ R.both(R.is(String), R.has(R.__, providedStylesheets)), R.prop(R.__, providedStylesheets) ],
            [ R.is(String), providedStylesheets.readTemplatedStylesheetFromFile ],
            [ R.T, R.identity ]
        ])(options.stylesheet),
        readImage = R.propOr(null, 'readImage', compositor),
        renderSprite = R.propOr(null, 'render', compositor);

    return readAllSources(options.src)
        .map(readImage, { concurrency: MAX_PARALLEL_FILE_READS })
        .then(R.partialRight(generateLayout, [ options.layoutOptions ]))
        .tap(function createTargetDirectories() {
            return Promise.join(
                R.when(isNotNull, R.pipe(path.dirname, mkdirp), options.stylesheetPath),
                R.when(isNotNull, R.pipe(path.dirname, mkdirp), options.spritePath)
            );
        })
        .then(function renderStylesheetAndImage(generatedLayout) {
            return Promise.all([
                renderStylesheet(generatedLayout, options.stylesheetOptions),
                renderSprite(generatedLayout, options.spritePath, options.compositorOptions)
            ]);
        })
        .tap(function writeStylesheetAndImage(args) {
            var stylesheet = args[0],
                sprite = args[1];

            return Promise.join(
                R.when(isNotNull, R.partialRight(writeFile, [ stylesheet ]), options.stylesheetPath),
                R.when(isNotNull, R.partialRight(writeFile, [ sprite ]), options.spritePath)
            );
        })
        .nodeify(callback);
}

generateSprite.middleware = function (options) {
    var changes = changeDetector(options);

    return function (req, res, next) {
        return changes.detect().then(function (changesDetected) {
            if (changesDetected) {
                return generateSprite(options)
                    .then(changes.register.bind(changes))
                    .then(next);
            }
            return next();
        }).catch(next);
    };
};

module.exports = generateSprite;
