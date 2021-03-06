var fs = require('fs'),
    path = require('path'),
    sphericalMerc = new(require('sphericalmercator')),
    invalid = require('./invalid'),
    srs = require('srs'),
    gdal = require('gdal'),
    mapnik = require('mapnik');

// Register datasource plugins
mapnik.register_default_input_plugins();

/**
 * Initializes the module
 * @param file (filepath)
 * @param filesize
 * @param filetype
 * @returns metadata {filesize, projection, filename, center, extent, json, minzoom, maxzoom, layers, dstype, filetype}
 */
function init(file, filesize, filetype, callback) {
    getDatasourceConfigs(file, filesize, filetype, function(err, configs) {
        if (err) return callback(err);
        return callback(null, configs);
    });
};
/**
 * Obtains metadata depending on file type
 * @param file (filepath)
 * @param filesize
 * @param filetype
 * @returns metadata {filesize, projection, filename, center, extent, json, minzoom, maxzoom, layers, dstype, filetype}
 */
function getDatasourceConfigs(file, filesize, filetype, callback) {
    getProjection(file, filetype, function(err, proj) {
        if(err) return callback(err);
        var name = path.basename(file, path.extname(file));
        if(filetype === '.geojson') name = name.replace('.geo', '');
                
        if(filetype === '.tif' || filetype === '.vrt') {
            processRasterDatasource(file, filesize, name, proj, filetype, function(err, info) {
                if(err) return callback(err);
                return callback(null, {
                    filesize: filesize,
                    projection: info.proj,
                    raster: info.raster,
                    filename: name,
                    center: info.center,
                    extent: info.extent,
                    minzoom: info.minzoom,
                    maxzoom: info.maxzoom,
                    dstype: info.dstype,
                    filetype: filetype,
                    layers: [name]
                });
            }); 
        // shapefile datasource
        } else if (filetype === '.shp' || filetype === '.csv') {
            processDatasource(file, filesize, name, proj, filetype, function(err, info) {
                if (err) return callback(err);
                return callback(null, {
                    filesize: filesize,
                    projection: proj,
                    filename: name,
                    center: info.center,
                    extent: info.extent,
                    json: info.json,
                    minzoom: info.minzoom,
                    maxzoom: info.maxzoom,
                    layers: info.layers,
                    dstype: info.dstype,
                    filetype: filetype
                });
            });
        // else OGR datasource
        } else {
            processOgrDatasource(file, filesize, name, proj, filetype, function(err, info) {
                if (err) return callback(err);
                return callback(null, {
                    filesize: filesize,
                    projection: proj,
                    filename: name,
                    center: info.center,
                    extent: info.extent,
                    json: info.json,
                    minzoom: info.minzoom,
                    maxzoom: info.maxzoom,
                    layers: info.layers,
                    dstype: info.dstype,
                    filetype: filetype
                });
            });
        }
    });
};
/**
 * Obtains projection based on filetype
 * @param file (filepath)
 * @param filetype
 * @returns projection String
 */
function getProjection(file, filetype, callback) {
    if (filetype === '.geojson' || filetype === '.csv') return callback(null, '+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs');
    //else if shape
    else if (filetype === '.shp') {
        projectionFromShape(file, function(err, proj) {
            if (err) return callback(err);
            return callback(null, proj);
        });
    //else if raster
    }
    else if(filetype === '.tif' || filetype === '.vrt') {
        projectionFromRaster(file, function(err, proj) {
            if (err) return callback(err);
            return callback(null, proj);
        });
    //else kml and gpx
    }
    else return callback(null, '+init=epsg:4326');
};
/**
 * Obtains extent from the datasource and the center point (lat/lng)
 * @param ds (Mapnik datasource)
 * @param projection
 * @param filetype
 * @returns results (results object that contains extent and center point)
 */
function getCenterAndExtent(ds, projection, filetype) {
    var extent;
    if (filetype === '.shp' || filetype === '.csv' || filetype === '.tif' || filetype === '.vrt') {
        // Convert datasource extent to lon/lat when saving
        var fromProj = new mapnik.Projection(projection);
        var toProj = new mapnik.Projection('+proj=longlat +ellps=WGS84 +datum=WGS84 +no_defs');
        var trans = new mapnik.ProjTransform(fromProj, toProj);
        //Bounding box
        extent = trans.forward(ds.extent());
    } else if (filetype === '.kml' || filetype === '.geojson' || filetype === '.gpx') {
        try {
            extent = ds.extent();
        } catch (err) {
            return invalid('Error obtaining extent of Mapnik datasource.');
        }
    }
    //Center point of bounding box (extent)
    var center = [0.5 * (extent[0] + extent[2]), 0.5 * (extent[1] + extent[3])];
    var results = {
        extent: extent,
        center: center
    }
    return results;
};
/**
 * Gets min/max zoom levels based on filesize
 * @param bytes (size of file)
 * @param extent
 * @returns callback(err, minzoom, maxzoom)
 */
function getMinMaxZoom(bytes, extent, callback) {
    //bytes in 1 mb = 1048576
    //bytes in 1.5 mb = 1572864
    //bytes in 2 mb = 2097152
    //Threshold for largest avg tilesize allowed
    var twoMB = 2097152;
    var minzoom = 0;
    var maxzoom = 16;
    //Calculate min/max zoom
    for (i = 16; i >= 0; i--) {
        var currentzoom = i;
        //Defaulting srs to WGS84 based on how the extent is set in mapnikSetup.getCenterAndExtent() function
        var bounds = sphericalMerc.xyz(extent, currentzoom, false, 4326);
        var x = (bounds.maxX - bounds.minX) + 1;
        var y = (bounds.maxY - bounds.minY) + 1;

        //Number of tiles within current zoom level
        var tiles = x * y;

        if (tiles <= 0) {
            return callback(invalid('Error calculating min/max zoom: Bounds invalid'));
        }
        if (bytes <= 0) {
            return callback(invalid('Error calculating min/max zoom: Total bytes less than or equal to zero'));
        }
        //Average tilesize within current zoom level
        var avgTileSize = bytes / tiles;

        //The idea is that tilesize of ~1000 bytes is usually the most detail needed, and no need to process tiles with higher zoom
        if (avgTileSize < 1000) {
            maxzoom = currentzoom;
        }
        //If avg tile size is small enough to get to one remaining tile, just set minzoom to zero.
        if (avgTileSize > twoMB) {
            minzoom = currentzoom;
            return callback(null, minzoom, maxzoom);
        } else if (tiles === 1 || i === 0) {
            minzoom = 0;
            return callback(null, minzoom, maxzoom);
        }
    };
};
/**********************
 * Shape and CSV files
 **********************/
 /**
 * Creates a mapnik Datasource and uses that to obtain the file's spatial properties
 * @param file (filepath)
 * @param filesize
 * @param name
 * @param proj
 * @param filetype
 * @returns object that contains spatial properties of the file {extent, center, json, minzoom, maxzoom, layers, dstype}
 */
function processDatasource(file, filesize, name, proj, filetype, callback) {
    var options = {};
    var dstype;
    //setup shape datasource options
    if(filetype === '.shp'){
        dstype = 'shape';
        options = {
            type: dstype,
            file: file,
            layer: name
        };
    //else setup csv datasource options
    } else {
        dstype = 'csv';
        options = {
            type: dstype,
            file: file,
            filesize_max:10,
            layer: name
        };
    }
    var ds = new mapnik.Datasource(options);
    //Center of bounding box/extent
    var results = getCenterAndExtent(ds, proj, filetype);
    //Get fields and setup vector layers json
    var actual = ds.describe();
    var fields = actual.fields;
    var json = {
        "vector_layers": [{
            "id": name,
            "description": "",
            "minzoom": 0,
            "maxzoom": 22,
            "fields": fields
        }]
    };
    getMinMaxZoom(filesize, results.extent, function(err, min, max) {
        if (err) return callback(err);
        //Values to input into xml for Mapnik
        return callback(null, {
            extent: results.extent,
            center: results.center,
            json: json,
            minzoom: min,
            maxzoom: max,
            layers: [options.layer],
            dstype: dstype
        });
    });
};
 /**
 * Obtains projection from a shapefile by reading the .prj file in the same directory
 * @param file (filepath)
 * @returns result.proj4
 */
function projectionFromShape(file, callback) {
    var fileDir = path.dirname(file);
    //Assumes the .prj file has the same name as the .shp file
    var projFile = fileDir + "/" + (path.basename(file, path.extname(file))) + '.prj';
    fs.readFile(projFile, function(err, data) {
        if(err) return callback(invalid('Missing projection file.'));
        var result;
        try {
            result = srs.parse(data);
        } catch (err) {
            return callback(invalid('Invalid projection file.'));
        }
        //TODO: check if the current projection is something we can deal with
        //...what are some projections we can't deal with?
        //Currently handles issues with ESRI projections
        if (result.proj4 === undefined) {
            var esriAppended = "ESRI::" + data.toString();
            projectionFromShape(esriAppended);
        } else {
            //Yay, Valid!
            return callback(null, result.proj4);
        }
    });
};


/********************
 * Raster/gdal files
 ********************/
/**
 * Obtains the Raster/GDAL file's spatial properties
 * @param file (filepath)
 * @param filesize
 * @param name
 * @param info Object
 * @param filetype
 * @returns object that contains spatial properties of the file {extent, center, raster properties, projection, minzoom, maxzoom, dstype}
*/
function processRasterDatasource(file, filesize, name, info, filetype, callback) {
    var options = {
        type: 'gdal', 
        file: file
    };
    try{
        var ds = new mapnik.Datasource(options);
        var ref = gdal.SpatialReference.fromProj4(info.proj4);
        var results = getCenterAndExtent(ds, info.proj4, filetype);
        //calculate source's min/max zoom
        getMinMaxZoomGDAL(info.raster.pixelSize, results.center, info.proj4, function(err, min, max) {
            if (err) return callback(err);
            //Values to input into xml for Mapnik
            return callback(null, {
                extent: results.extent,
                center: results.center,
                raster: info.raster,
                proj: info.proj4,
                minzoom: 0,
                maxzoom: max,
                dstype: 'gdal'
            });
        });
    } catch(err){
        return callback(invalid(err));
    }
};
/**
 * Calculates a GDAL source's min and max zoom level using native pixel size and converting to google mercator (meters)
 * @param pixelSize (source's pixel size Array)
 * @param center (source's center point Array)
 * @param proj (source's srs String)
 * @returns callback(err, minzoom, maxzoom)
 */
function getMinMaxZoomGDAL(pixelSize, center, proj, callback){
    var refFrom = new gdal.SpatialReference.fromProj4(proj);
    var refTo = new gdal.SpatialReference.fromEPSG(3857);
    var transform = new gdal.CoordinateTransformation(refFrom, refTo);
    
    //Grab half of pixelsize and add/subtract to center longitude to create a horizontal line 
    var halfPixelsPerUnit = pixelSize[0]/2;
    var line = new gdal.LineString();
    line.points.add(center[0], (center[1] - halfPixelsPerUnit));
    line.points.add(center[0], (center[1] + halfPixelsPerUnit));
    //Transform native res pixel distance to google mercator pixel distance in meters
    line.transform(transform);
    var mercatorPixelSize = line.getLength();

    //After transforming pixelsize, earth circumference will always be in meters...?
    var circ = 40075000;
    var lat = center[1];
    var res;
    var maxzoom;

    //iterate through zoom levels to find threshold and set maxzoom
    for(var zoom = 19; zoom >=0; zoom--){
        //calculate resolution (meters/pixel) for each zoom level
        //S=C*cos(y)/2^(z+8)...from http://wiki.openstreetmap.org/wiki/Zoom_levels
        res = circ * Math.cos(lat) / Math.pow(2,(zoom+8));

        //use the source's resolution as the threshold
        if(res >= mercatorPixelSize){
            maxzoom = zoom;
            return callback(null, 0, maxzoom);
        }
        if (zoom <= 0) return callback(invalid('Failed to set min/max zoom'));
    }
};
/**
 * Detects unit type of the gdal source, using the srs/projection
 * @param srs
 * @returns unit type (String) 
 */
function getUnitType(srs){
    var possibleUnits = ['m','ft','mi','km','us-ft','us-mi'];
    for(var i = 0; i < possibleUnits.length; i++){
        if(srs.indexOf("+units=" + possibleUnits[i]) !== -1) return possibleUnits[i];
    }
    if(srs.indexOf("+units=") === -1 && srs.indexOf("+proj=longlat") !== -1) return 'decimal degrees';
    //Default to meters for now, if nothing matches
    else return 'm';
};
/**
 * Obtains projection from a raster by using node-gdal lib
 * @param file (filepath)
 * @returns result.proj4 and raster properties object
 */
function projectionFromRaster(file, callback) {
    var ds;
    var proj;
    var band;
    var bandCount;
    var bandStats;
    var width;
    var height;
    var geotransform;
    var bands;
    var nodata;
    var unitType;
    var metadata;
    var fileList;
    var srsResult;
    
    try {
        ds = gdal.open(file);
        geotransform = ds.geoTransform;
        bandCount = ds.bands.count();
        width = ds.rasterSize.x;
        height = ds.rasterSize.y;
        proj = ds.srs.toWKT();
        fileList = ds.getFileList();
        //get srs string
        srsResult = srs.parse(proj);

        //get native units/pixel
        var ref = gdal.SpatialReference.fromProj4(srsResult.proj4);
        var linearUnits = ref.getLinearUnits();
        var angularUnits = ref.getAngularUnits();
        
        //get bands and bandStats
        bands = getBands(ds, bandCount);
        if(bands instanceof Error) return callback(bands);
    } catch(err) {
        return callback(invalid('Invalid gdal source. ' + err));
    }   

    //TODO: check if the current projection is something we can deal with
    //...what are some projections we can't deal with?
    if(srsResult.proj4 === undefined){
        return callback(invalid('Undefined projection from gdal source.'));
    } else return callback(null, {
        'proj4': srsResult.proj4,
        'raster':{
            'pixelSize': [geotransform[1],-geotransform[5]], 
            'bandCount': bandCount,
            'bands': bands,
            'nodata': bands[0].nodata,
            'origin': [geotransform[0], geotransform[3]],
            'width': width,
            'height': height,
            'units':{
                'linear': linearUnits,
                'angular': angularUnits
            }
        }
    });
};
/**
 * Iterates through source's bands and obtains band properties
 * @param ds (Datasource)
 * @param bandcount
 * @returns bands Array
 */
function getBands(ds, bandCount){
    var bands = [];
    var band;
    var unitType;
    var bandStats;
    var nodata;
    for(var i = 1; i <= bandCount; i++){
        band = ds.bands.get(i);
        nodata = band.noDataValue;
        unitType = ds.bands.get(i).unitType;
        //Error check file sources
        try { 
            bandStats = band.getStatistics(false, true);
        } catch(err){
            return invalid("Error getting statistics of band. 1 or more of the VRT file's relative sources may be missing: " + err);
        };
        //add to bands array
        bands.push({
            //commenting out band for now, seems to be erroring out when trying to stringify C++ object
            //'band':band, 
            'stats':bandStats,
            'scale':band.scale,
            'unitType':unitType,
            'rasterDatatype':band.dataType,
            'categoryNames':band.categoryNames,
            'hasArbitraryOverviews':band.hasArbitraryOverviews,
            'overviews':band.overviews,
            'nodata':nodata,
            'id':band.id,
            'blockSize':band.blockSize,
            'color':band.colorInterpretation
        });
    };
    return bands;
};

/************
 * OGR files
 ************/
/**
 * Obtains the OGR file's spatial properties
 * @param file (filepath)
 * @param filesize
 * @param name
 * @param proj
 * @param filetype
 * @returns object that contains spatial properties of the file {extent, center, json, minzoom, maxzoom, layers, dstype}
 */
function processOgrDatasource(file, filesize, name, proj, filetype, callback) {
    getDatasource(file, name, filetype, function(err, layers, json, ds) {
        if (err) return callback(err);
        var results = getCenterAndExtent(ds, proj, filetype);
        //if error returned from synchronous function, send Error to callback
        if (results instanceof Error) {
            return callback(results);
        };
        getMinMaxZoom(filesize, results.extent, function(err, min, max) {
            if (err) return callback(err);
            //Values to input into xml for Mapnik
            return callback(null, {
                extent: results.extent,
                center: results.center,
                json: json,
                minzoom: min,
                maxzoom: max,
                layers: layers,
                dstype: 'ogr'
            });
        });
    });
};
 /**
 * Creates a mapnik Datasource and uses that to obtain the file's spatial properties
 * @param file (filepath)
 * @param name
 * @param filetype
 * @returns layers (file's layer names) 
 *          json (vector_layers array) 
 *          ds (mapnik Datasource)
 */
function getDatasource(file, name, filetype, callback) {
    var dstype = 'ogr';
    //Get layers for kml
    if (filetype === '.kml') {
        var options = {
            type: dstype,
            file: file
        };
        //Get KML layer names from the OGR error message...for now
        getKmlLayers(options, function(err, layers) {
            if (err) return callback(err);
            setLayerConfigs(options, layers, name, function(err, json, ds) {
                if (err) return callback(err);
                else return callback(null, layers, json, ds);
            });
        });
        //Get layer for .geojson
    } else if (filetype === '.geojson') {
        var options = {
            type: dstype,
            file: file,
            layer_by_index: 0
        }
        //All .geojson files have one layer under this name
        var layers = ['OGRGeoJSON'];
        setLayerConfigs(options, layers, name, function(err, json, ds) {
            if (err) return callback(err);
            return callback(null, layers, json, ds);
        });
        //Get layers for .gpx
    } else if (filetype === '.gpx') {
        var options = {
            type: dstype,
            file: file
        };
        //GPX files always have these three layers
        var layers = ['waypoints', 'routes', 'tracks'];
        setLayerConfigs(options, layers, name, function(err, json, ds) {
            if (err) return callback(err);
            return callback(null, layers, json, ds);
        });
    }
};
//Sole purpose is to obtain layer names from OGR error message
function getKmlLayers(options, callback) {
    var layers_array;
    var error;
    //Expect an error in order to obtain layer names from the OGR Error string...for now
    try {
        var ds = new mapnik.Datasource(options);
    } catch (err) {
        if (err.message && err.message.indexOf('OGR Plugin: missing <layer>') != -1) {
            var layers = err.message.split("are: ")[1];
            //trim whitespaces before each layer
            layers = layers.replace(/\s*,\s*/g, ',');
            //remove quotes
            var layer_names = layers.split('\'').join('');
            //designate each index of the array by splitting by commas
            layers_array = layer_names.split(',');
        } else error = err;
    }
    if (error === undefined) return callback(null, layers_array);
    else return callback(invalid('Error obtaining KML layer names'));
};
//Iterate through all layers and create a corresponding datasource and vector_layers json
function setLayerConfigs(options, layers, filename, callback) {
    var json = {
        "vector_layers": []
    };
    //only .geojson uses the layer_by_index property
    if (options.layer_by_index === 0) {
        try {
            var ds = new mapnik.Datasource(options);
            //Get shapefile fields and setup vector layers json
            var actual = ds.describe();
            var fields = actual.fields;
            json.vector_layers.push({
                "id": 'OGRGeoJSON',
                "description": "",
                "minzoom": 0,
                "maxzoom": 22,
                "fields": fields
            });
            return callback(null, json, ds);
        } catch (err) {
            return callback(invalid('Error creating Mapnik Datasource for .geojson file'));
        }
        //else obtain layers from KML or gpx file
    } else {
        var validDatasource;
        var error;
        layers.forEach(function(layer) {
            options.layer = layer;
            try {
                var ds = new mapnik.Datasource(options);
                //Get shapefile fields and setup vector layers json
                var actual = ds.describe();
                var fields = actual.fields;
                json.vector_layers.push({
                    "id": layer.split(' ').join('_'),
                    "description": "",
                    "minzoom": 0,
                    "maxzoom": 22,
                    "fields": fields
                });
                //The last ds created in the foreach loop above is used for center and extent as long as it's not empty
                if (ds.extent().indexOf(0) === -1) validDatasource = ds;
            } catch (err) {
                error = invalid('Error creating Mapnik Datasource for file: ' + err.message);
            }
        });
        
        if (error === undefined && validDatasource !== undefined) return callback(null, json, validDatasource);
        else return callback(error);
    }
};
module.exports = {
    init: init,
    getCenterAndExtent: getCenterAndExtent,
    setLayerConfigs: setLayerConfigs,
    getMinMaxZoom: getMinMaxZoom,
    getMinMaxZoomGDAL: getMinMaxZoomGDAL,
    getProjection: getProjection,
    projectionFromRaster: projectionFromRaster

};
