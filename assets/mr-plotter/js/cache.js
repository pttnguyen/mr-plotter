/** The Cache class represents the second layer of cache. The only methods for
    external use are ensureData and limitMemory. */

function Cache(requester) {
    /* The dataCache maps UUID to an object that maps the point width exponent to
       cached data. The array contains cached entries, objects that store a start
       time, end time, and data; the cached entries never overlap, are consolidated
       when possible, and are stored sequentially. */
    this.dataCache = {};

    // The total number of data points that have been cached.
    this.loadedData = 0;
    this.loadedStreams = {}; // maps a stream's uuid to the total number of points that have been cached for that stream
    this.lastTimes = {}; // maps a stream's uuid to the time of the last point where there is valid data, obtained from the server
    this.pollingBrackets = false; // whether or not we are periodically checking if the brackets have changed
    this.bracketInterval = 5000;
    
    this.queryLow = [-1152921504607, 153025];
    this.queryHigh = [3458764513820, 540927];
    this.pweHigh = 62;
    
    // The following fields are for rate control
    this.currPWE = undefined;
    this.secondaryPWE = undefined;
    this.pendingSecondaryRequests = 0;
    this.pendingSecondaryRequestData = {};
    this.pendingRequests = 0;
    
    // So we can make the requests for data when necessary
    this.requester = requester;
}

/*Cache.zNormal = new THREE.Vector3(0, 0, 0);*/

/* The start time and end time are two-element arrays. */
function CacheEntry(startTime, endTime, data) {
    this.start_time = startTime;
    this.end_time = endTime;
    this.cached_data = data;
    this.cached_drawing = {};
    this.inPrimaryCache = false;
    this.inSummaryCache = false;
    this.inSecondaryCache = true;
}

CacheEntry.prototype.getLength = function () {
        var length = 0;
        for (var i = 0; i < this.cached_data.length; i++) {
            length += this.cached_data[i].length;
        }
        return length;
    };
    
CacheEntry.prototype.compressIfPossible = function () {
        var graph = this.cached_drawing.graph;
        var rangegraph = this.cached_drawing.rangegraph;
        var ddplot = this.cached_drawing.ddplot;
        /*if (graph.vertices.length > 0 && !graph.verticesNeedUpdate) {
            graph.vertices = [];
        }
        if (graph.faces.length > 0 && !graph.elementsNeedUpdate) {
            graph.faces = [];
        }
        if (rangegraph.vertices.length > 0 && !rangegraph.verticesNeedUpdate) {
            rangegraph.vertices = [];
        }
        if (rangegraph.faces.length > 0 && !rangegraph.elementsNeedUpdate) {
            rangegraph.faces = [];
        }
        if (ddplot.vertices.length > 0 && !ddplot.verticesNeedUpdate) {
            ddplot.vertices = [];
        }
        if (ddplot.faces.length > 0 && !ddplot.elementsNeedUpdate) {
            ddplot.faces = [];
        }*/
    };
    
CacheEntry.prototype.freeDrawing = function () {
        this.cached_drawing.graph.dispose();
        this.cached_drawing.rangegraph.dispose();
        this.cached_drawing.ddplot.dispose();
        this.cached_drawing = {};
    };
    
CacheEntry.prototype.disposeIfPossible = function () {
        if (!this.inSecondaryCache && !this.inPrimaryCache && !this.inSummaryCache) {
            if (this.cached_drawing.hasOwnProperty("graph")) {
                this.compressIfPossible(); // help speed up garbage collection
                this.freeDrawing();
            }
        }
    };
    
CacheEntry.prototype.removeFromSecCache = function () {
        this.inSecondaryCache = false;
        this.disposeIfPossible();
    };

/* Ensures that CACHE, an array of cache entries, is not corrupted. Included
   for debugging. */
Cache.prototype.validateCache = function (cache) {
        var currEntry;
        var invalid = false;
        var condition = 0;
        for (var i = 0; i < cache.length; i++) {
            currEntry = cache[i];
            if (currEntry == undefined) {
                invalid = true;
                condition = 1;
            } else if (currEntry.end_time <= currEntry.start_time) {
                invalid = true;
                condition = 2;
            } else if (i > 0 && currEntry.start_time <= cache[i - 1].end_time) {
                invalid = true;
                condition = 3;
            }
            if (invalid) {
                alert("CORRUPTED CACHE!!! " + condition);
                console.log(cache);
                console.log(this.dataCache);
                return true;
            }
        }
        return false;
    };

/* Ensures that loadedData is correct. Returns true if it is correct, and
   false if it is corrupted. This function is included for debugging. */
Cache.prototype.validateLoaded = function () {
        var total = 0;
        var uuid;
        var pw;
        var i;
        var cache;
        var dataCache = this.dataCache;
        for (uuid in dataCache) {
            if (dataCache.hasOwnProperty(uuid)) {
                for (pw in dataCache[uuid]) {
                    if (dataCache[uuid].hasOwnProperty(pw)) {
                        cache = dataCache[uuid][pw];
                        for (i = 0; i < cache.length; i++) {
                            total += cache[i].getLength();
                        }
                    }
                }
            }
        }
        console.log(total + " " + this.loadedData);
        return total == this.loadedData;
    };

/* Checks if there are any holes in a cache entry and prints out information
   about the holes if they exist. Used for debugging. */
function validateContiguous(cacheEntry, pwe) {
    var di;
    var pw = Math.pow(2, pwe);
    var diLimit = cacheEntry.getLength() - 1;
    for (di = 0; di < diLimit; di++) {
        if (((cacheEntry.cached_data[di + 1][0] - cacheEntry.cached_data[di][0]) * 1000000) + cacheEntry.cached_data[di + 1][1] - cacheEntry.cached_data[di][1] != pw) {
            console.log('Gap');
            console.log(((cacheEntry.cached_data[di + 1][0] - cacheEntry.cached_data[di][0]) * 1000000) + cacheEntry.cached_data[di + 1][1] - cacheEntry.cached_data[di][1]);
            console.log(pw);
            console.log(di);
        }
    }
}

/** Given the result of a bracket call, invalidates the part of the cache
    between the previous end time and the new end time. This portion of the
    cache should only contain a lack of data; that is, only the end time
    should be trimmed on the last cache entry. BRACKETRESP is the JSON
    object returned by the server-side code, and CURREND is what is last time
    which is in the user's field of view. If data is removed from the cache
    before CURREND (meaning it may affect what the user is seeing at the time
    the function is called), the function returns true. Otherwise, it returns
    false. */
Cache.prototype.updateToBrackets = function (bracketResp, currEnd) {
        var mustRefresh = false;
        var prevTime;
        for (var uuid in bracketResp) {
            if (bracketResp.hasOwnProperty(uuid)) {
                if (this.lastTimes.hasOwnProperty(uuid)) {
                    if (this.dataCache.hasOwnProperty(uuid) && cmpTimes((prevTime = this.lastTimes[uuid]), bracketResp[uuid][1]) < 0) {
                        this.trimCache(uuid, prevTime);
                        this.lastTimes[uuid] = bracketResp[uuid][1];
                        mustRefresh = mustRefresh || (cmpTimes(prevTime, currEnd) <= 0);
                    }
                } else {
                    // I don't know how far back the last legitimate time was, so I'm going to throw away the whole thing to be safe
                    this.lastTimes[uuid] = bracketResp[uuid][1];
                    if (this.loadedStreams.hasOwnProperty(uuid)) {
                        this.loadedData -= this.loadedStreams[uuid];
                        for (pointwidth in this.dataCache[uuid]) {
                            if (this.dataCache[uuid].hasOwnProperty(pointwidth)) {
                                for (var i = 0; i < this.dataCache[uuid][pointwidth].length; i++) {
                                    this.dataCache[uuid][pointwidth][i].removeFromSecCache();
                                }
                            }
                        }
                        delete this.dataCache[uuid];
                        delete this.loadedStreams[uuid];
                        mustRefresh = true;
                    }
                }
            }
        }
        return mustRefresh;
    };

/* Ensures that the stream with the specified UUID has data cached from
   STARTTIME to ENDTIME at the point width corresponding to POINTWIDTHEXP, or
   floor(lg(POINTWIDTH)). If it does not, data are procured from the server and
   added to the cache so the extent of its data is at least from STARTTIME to
   ENDTIME. STARTTIME and ENDTIME are specified in UTC (Universal Coord. Time).
   Once the data is found or procured, CALLBACK is called with the Cache Entry
   containing the data as its argument. If another call to this function is
   pending (it has requested data from the server) for a certain stream, any
   more calls for that stream will not result in a GET request (so this
   function doesn't fall behind user input).
   
   STARTTIME and ENDTIME are aliased in the cache, so pass in a copy. If you
   don't, editing those same variables later could make the cache invalid. */
Cache.prototype.getData = function (uuid, pointwidthexp, startTime, endTime, callback, caching) {
        pointwidthexp = Math.min(this.pweHigh, pointwidthexp);
        
        var queryStart = startTime;
        var queryEnd = endTime;
        
        var halfpwnanos = expToPW(pointwidthexp - 1);
        
        /* queryStart and queryEnd are the start and end of the query I want,
        in terms of the midpoints of the intervals I get back; the real archiver
        will interpret the query in terms of the start times of the intervals. So
        I add a constant to the start and end times.
        QUASAR rounds down the endtime and then treats it as exclusive; that makes
        things more difficult, since now I can't use the endtime as the data_end of
        each cache entry; I have to first make the query with endtime + 2 ^ pw, and
        then use endtime - 2 ^ pw in the cacheEntry, since otherwise I'll miss the last
        point in each entry. The backend will add 2 ^ pw to each endtime to account for
        this, so as far as the cache is concerned, data is provided with the endtime
        rounded down and then treated as inclusive.*/
        if (pointwidthexp == 0) { // edge case. We don't want to deal with half nanoseconds
            halfpwnanos = [0, 0];
        }
        var trueStart = addTimes(queryStart.slice(0), halfpwnanos);
        var trueEnd = addTimes(queryEnd.slice(0), halfpwnanos);
        
        if (cmpTimes(trueEnd, trueStart) <= 0) { // it's possible for this to happen, if the range is smaller than an interval
            trueEnd[0] = trueStart[0];
            trueEnd[1] = trueStart[1];
            subTimes(trueStart, [0, 1]);
        }
        
        var startlow = [this.queryLow[0], this.queryLow[1]];
        var endlow = [this.queryLow[0], this.queryLow[1]];
        var starthigh = [this.queryHigh[0], this.queryHigh[1]];
        var endhigh = [this.queryHigh[0], this.queryHigh[1]];
        
        addTimes(endlow, [0, 1]);
        subTimes(starthigh, [0, 1]);
        
        startTime = boundToRange(trueStart, startlow, starthigh); // the times we're going to query if necessary
        endTime = boundToRange(trueEnd, endlow, endhigh);
        var dataCache = this.dataCache;
        // Create the mapping for this stream if it isn't already present
        if (!dataCache.hasOwnProperty(uuid)) {
            dataCache[uuid] = {};
            this.loadedStreams[uuid] = 0;
        }
        var cache;
        // Find the relevant cache, creating it if necessary
        if (dataCache[uuid].hasOwnProperty(pointwidthexp)) {
            cache = dataCache[uuid][pointwidthexp];
        } else {
            cache = [];
            dataCache[uuid][pointwidthexp] = cache;
        }
        
        var indices = getIndices(cache, startTime, endTime);
        var i = indices[0];
        var j = indices[1];
        var startsBefore = indices[2];
        var endsAfter = indices[3];
        var queryStart = startsBefore ? startTime : cache[i].end_time;
        var queryEnd = endsAfter ? endTime : cache[j].start_time;
        
        var numRequests = j - i + startsBefore + endsAfter; 
        if (numRequests == 0) {
            callback(cache[i]);
        } else {
            // Fetch the data between the cache entries, and consolidate into one entry
            var si = i;
            var numReceived = 0;
            var self = this;
            var urlCallback = function (streamdata, start, end) {
                    var callbackToUse;
                    if (++numReceived == numRequests) {
                        callbackToUse = callback;
                    } else {
                        callbackToUse = function () {};
                    }
                    if (dataCache.hasOwnProperty(uuid) && dataCache[uuid][pointwidthexp] == cache) { // If the stream or pointwidth has been deleted to limit memory, just return and don't cache
                        if (typeof(streamdata) === "string") {
                            console.log('Invalid data response from server: ' + streamdata);
                            // Just use the previous data that was cached for drawing
                            callback(undefined);
                            return;
                        }
                        self.insertData(uuid, cache, streamdata, start, end, callbackToUse);
                    }
                };
            
            if (numRequests == 1) {
                this.makeDataRequest(uuid, queryStart, queryEnd, pointwidthexp, urlCallback, caching);
            } else {
                if (startsBefore) {
                    i--;
                }
                if (endsAfter) {
                    j++;
                }
                this.makeDataRequest(uuid, queryStart, cache[i + 1].start_time, pointwidthexp, urlCallback, caching);
                for (var k = i + 1; k < j - 1; k++) {
                    this.makeDataRequest(uuid, cache[k].end_time, cache[k + 1].start_time, pointwidthexp, urlCallback, caching);
                }
                this.makeDataRequest(uuid, cache[j - 1].end_time, queryEnd, pointwidthexp, urlCallback, caching);
            }
        }
    };

/* Gets all the points where the middle of the interval is between queryStart
   and queryEnd, including queryStart but not queryEnd. HALFPWNANOS should be
   Math.pow(2, pointwidthexp - 1). */
Cache.prototype.makeDataRequest = function (uuid, trueStart, trueEnd, pointwidthexp, callback, caching) {
        var req = [uuid, timeToStr(trueStart), timeToStr(trueEnd), pointwidthexp];
        if (caching) {
            this.requester.makeDataRequest(req, function (data) {
                    callback(data, trueStart, trueEnd);
                });
        } else {
            this.queueRequest(req, function (data) {
                    callback(data, trueStart, trueEnd);
                }, pointwidthexp);
        }
    };

Cache.prototype.queueRequest = function (req, callback, pwe) {
        if (this.pendingRequests == 0) {
            this.currPWE = pwe;
        }
        var self = this;
        if (this.currPWE == pwe) {
            this.pendingRequests++;
            this.requester.makeDataRequest(req, function (data) {
                    self.pendingRequests--;
                    callback(data);
                    if (self.pendingRequests == 0) {
                        self.effectSecondaryRequests();
                    }
                });
        } else {
            if (pwe != this.secondaryPWE) {
                this.secondaryPWE = pwe;
                this.pendingSecondaryRequests = 0;
                this.pendingSecondaryRequestData = {};
            }
            this.pendingSecondaryRequests++;
            var id = setTimeout(function () {
                    if (self.pendingSecondaryRequestData.hasOwnProperty(id)) {
                        self.requester.makeDataRequest(req, callback);
                        self.pendingSecondaryRequests--;
                        delete self.pendingSecondaryRequestData[id];
                    }
                }, 1000);
            this.pendingSecondaryRequestData[id] = [req, callback];
        }
    };

Cache.prototype.effectSecondaryRequests = function () {
        if (this.secondaryPWE == undefined || this.pendingSecondaryRequests == 0) {
            return;
        }
        this.currPWE = this.secondaryPWE;
        this.pendingRequests = this.pendingSecondaryRequests;
        this.secondaryPWE = undefined;
        var entry;
        var pendingData = this.pendingSecondaryRequestData;
        var self = this;
        for (var id in pendingData) {
            if (pendingData.hasOwnProperty(id)) {
                clearTimeout(id);
                entry = pendingData[id];
                this.requester.makeDataRequest(entry[0], (function (cb) {
                        return function (data) {
                                self.pendingRequests--;
                                cb(data);
                            };
                    })(entry[1]));
            }
        }
        this.pendingSecondaryRequestData = {};
        this.pendingSecondaryRequests = 0;
    };

Cache.prototype.insertData = function (uuid, cache, data, dataStart, dataEnd, callback) {
        var indices = getIndices(cache, dataStart, dataEnd);
        var i = indices[0];
        var j = indices[1];
        var startsBefore = indices[2];
        var endsAfter = indices[3];
        if (i == j && !startsBefore && !endsAfter) {
            callback(cache[i]);
            return;
        }
        
        var dataBefore;
        var dataAfter;
        var cacheStart;
        var cacheEnd;
        var m = 0; // the first index of data that we need
        var n = data.length; // the first index of data that we don't need, where n > m
        if (startsBefore) {
            cacheStart = dataStart;
            dataBefore = [];
        } else {
            cacheStart = cache[i].start_time;
            dataBefore = cache[i].cached_data;
            if (data.length > 0) {
                // We want to get rid of overlap
                m = binSearchCmp(data, cache[i].end_time, cmpTimes);
                if (cmpTimes(data[m], cache[i].end_time) < 0) {
                    m++;
                }
            }
        }
        
        if (endsAfter) {
            cacheEnd = dataEnd;
            dataAfter = [];
        } else {
            cacheEnd = cache[j].end_time;
            dataAfter = cache[j].cached_data;
            if (data.length > 0) {
                // We want to get rid of overlap
                n = binSearchCmp(data, cache[j].start_time, cmpTimes)
                if (cmpTimes(data[n], cache[j].start_time) >= 0) {
                    n--;
                }
                n++;
            }
        }
        
        var entryLength;
        var loadedStreams = this.loadedStreams;
        for (var k = i; k <= j; k++) {
            // Update the amount of data has been loaded into the cache
            entryLength = cache[k].getLength();
            this.loadedData -= entryLength;
            loadedStreams[uuid] -= entryLength;
            // Dispose of the geometries to avoid leaking memory
            cache[k].removeFromSecCache();
        }
        
        var cacheEntry;
        if (m == n) {
            if (dataBefore.length > 0) {
                cacheEntry = new CacheEntry(cacheStart, cacheEnd, $.merge(dataBefore, dataAfter));
            } else {
                cacheEntry = new CacheEntry(cacheStart, cacheEnd, dataAfter);
            }
        } else {
            cacheEntry = new CacheEntry(cacheStart, cacheEnd, $.merge($.merge(dataBefore, [data.slice(m, n)]), dataAfter));
        }
        entryLength = cacheEntry.getLength(); // Perhaps we could optimize this? Probably not necessary though.
        this.loadedData += entryLength;
        loadedStreams[uuid] += entryLength;
        cache.splice(i, j - i + 1, cacheEntry);
        callback(cacheEntry);
    };

/* Given CACHE, an array of cache entries, and a STARTTIME and an ENDTIME,
   provides the necessary information to determine what data in that interval
   is not present in CACHE (where the interval includes STARTTIME but does not
   include ENDTIME). Returns a four element array. The first element is a number
   i such that STARTTIME either occurs in the cache entry at index i or between
   the cache entries at indices i - 1 and i. The second element is a number j
   such that ENDTIME either occurs in the cache entry at index j or between the
   cache entries at indices j and j + 1. The third element, a boolean, is false
   if STARTTIME occurs in the cache entry at index i and true if it is between
   the cache entries at indices i - 1 and i. The fourth element, also a boolean,
   false if ENDTIME occurs in the cache entry at index j and true if it is
   between the cache entries at indices j and j + 1 */
function getIndices(cache, startTime, endTime) {
    var startsBefore; // false if startTime starts during the cacheEntry at index i, true if it starts before
    var endsAfter; // false if endTime ends during the cacheEntry at index j, true if it ends after
    
    // Figure out whether the necessary data is in the cache
    var i, j;
    if (cache.length > 0) {
        // Try to find the cache entry with data, or determine if there is no such entry
        i = binSearchCmp(cache, {start_time: startTime}, cmpEntryStarts);
        if (cmpTimes(startTime, cache[i].start_time) < 0) {
            i--;
        } // Now, startTime is either in entry at index i, or between index i and i + 1, or at the very beginning
        if (i == -1) {
            // new data starts before all existing records
            i = 0;
            startsBefore = true;
        } else if (cmpTimes(startTime, cache[i].end_time) <= 0) {
            // new data starts in cache entry at index i
            startsBefore = false;
        } else {
            // new data starts between cache entries at index i and i + 1
            startsBefore = true;
            i++; // so we don't delete the entry at index i
        }
        
        j = binSearchCmp(cache, {end_time: endTime}, cmpEntryEnds); // endTime is either in entry at index j, or between j - 1 and j, or between j and j + 1
        if (cmpTimes(endTime, cache[j].end_time) > 0) {
            j++;
        } // Now, endTime is either in entry at index j, or between index j - 1 and j, or at the very end
        if (j == cache.length) {
            // new data ends after all existing records
            j -= 1;
            endsAfter = true;
        } else if (cmpTimes(endTime, cache[j].start_time) >= 0) {
            // new data ends in cache entry at index j
            endsAfter = false;
        } else {
            // new data ends between cache entries at index j - 1 and j
            endsAfter = true;
            j--; // So we don't delete the entry at index j
        }
    } else {
        // Set variables so the first entry is created
        startsBefore = true;
        i = 0;
        
        endsAfter = true;
        j = -1;
    }
    return [i, j, startsBefore, endsAfter];
}

function cmpEntryStarts(entry1, entry2) {
    return cmpTimes(entry1.start_time, entry2.start_time);
}

function cmpEntryEnds(entry1, entry2) {
    return cmpTimes(entry1.end_time, entry2.end_time);
}

/* Excise the portion of the cache for the stream with UUID where the time is
   strictly greater than LASTTIME. The excising is done at all resolutions.
   LASTTIME is specified in milliseconds in Universal Coordinated Time (UTC). */
Cache.prototype.trimCache = function (uuid, lastTime) {
        var dataCache = this.dataCache;
        var data, datalength, mustTrimEntry;
        if (dataCache.hasOwnProperty(uuid)) {
            var cache = dataCache[uuid];
            for (var resolution in cache) {
                if (cache.hasOwnProperty(resolution)) {
                    var entries = cache[resolution];
                    if (entries.length == 0) {
                        continue;
                    }
                    var index = binSearchCmp(entries, {start_time: lastTime}, cmpEntryStarts);
                    
                    if (cmpTimes(entries[index].start_time, lastTime) > 0) {
                        index--;
                    }
                    // All entries at an index strictly greater than index will be deleted.
                    
                    var excised = entries.splice(index + 1, entries.length);
                    for (var i = 0; i < excised.length; i++) {
                        datalength = excised[i].getLength();
                        this.loadedData -= datalength;
                        this.loadedStreams[uuid] -= datalength;
                        excised[i].removeFromSecCache();
                    }
                    
                    if (index >= 0 && cmpTimes(entries[index].end_time, lastTime) >= 0 && (datalength = entries[index].getLength()) > 0) {
                        data = entries[index].cached_data;
                        var entryIndex = binSearchCmp(data, [lastTime], cmpFirstTimes);
                        if (cmpFirstTimes(data[entryIndex], [lastTime]) <= 0 && entryIndex < data.length - 1) {
                            entryIndex++;
                        }
                        if (data[entryIndex].length == 0) {
                            continue;
                        }
                        // All chunks in the entry at an index strictly greater than entryIndex will be deleted.
                        var pointIndex = binSearchCmp(data[entryIndex], lastTime, cmpTimes);
                        if (cmpTimes(data[entryIndex][pointIndex], lastTime) <= 0) {
                            pointIndex++;
                        }
                        // All points in the chunk greater at an index than or equal to pointIndex will be deleted.
                        entries[index].end_time = lastTime;
                        
                        if (pointIndex == 0 && entryIndex > 0) { // So we don't end up with an empty chunk
                            entryIndex--;
                            pointIndex = data[entryIndex].length;
                        }
                        
                        // The only way we can end up with an empty chunk now is if this entire entry is trimmed away.
                        
                        var numgroups = entries[index].cached_data.length - entryIndex - 1;
                        for (var i = entryIndex + 1; i < data.length; i++) {
                            this.loadedData -= data[i].length;
                        }
                        data.splice(entryIndex + 1, numgroups);
                        var numpoints = data[entryIndex].length - pointIndex;
                        data[entryIndex].splice(pointIndex, numpoints);
                        this.loadedData -= numpoints;
                        if (entries[index].cached_drawing.graph !== undefined) {
                            entries[index].freeDrawing();
                        }
                    }
                }
            }
        }
    };
    
function cmpFirstTimes(entry1, entry2) {
    return cmpTimes(entry1[0], entry2[0]);
}

/* Reduce memory consumption by removing some cached data. STARTTIME and
   ENDTIME are in UTC (Universal Coord. Time) and represent the extent of the
   current view (so the presently viewed data is not erased). CURRPWE is the
   pointwidth at which the data is currently being viewed. If current memory
   consumption is less than THRESHOLD, nothing will happen; otherwise, memory
   comsumption is decreased to TARGET or lower. Returns true if memory
   consumption was decreased; otherwise, returns false. */
Cache.prototype.limitMemory = function (streams, startTime, endTime, currPWE, threshold, target) {
        if (this.loadedData < threshold) {
            return false;
        }
        
        var dataCache = this.dataCache;
        var loadedStreams = this.loadedStreams;
        var i, j, k;
        
        // Delete extra streams
        var uuid;
        var used;
        var pointwidth;
        var node;
        for (uuid in dataCache) {
            if (dataCache.hasOwnProperty(uuid)) {
                used = false;
                for (node = streams.head; node !== null; node = node.next) {
                    if (node.elem.uuid == uuid) {
                        used = true;
                        break;
                    }
                }
                if (!used) {
                    this.loadedData -= this.loadedStreams[uuid];
                    for (pointwidth in this.dataCache[uuid]) {
                        if (this.dataCache[uuid].hasOwnProperty(pointwidth)) {
                            for (i = 0; i < this.dataCache[uuid][pointwidth].length; i++) {
                                this.dataCache[uuid][pointwidth][i].removeFromSecCache();
                            }
                        }
                    }
                    delete this.dataCache[uuid];
                    delete this.loadedStreams[uuid];
                    if (this.lastTimes.hasOwnProperty(uuid)) {
                        delete this.lastTimes[uuid];
                    }
                }
            }
        }
        if (this.loadedData <= target) {
            return true;
        }

        // Delete extra point width caches, if deleting streams wasn't enough
        var cache;
        var pointwidth, pointwidths;
        var pwMap = {}; // Maps uuid to 2-element array containing sorted array of pointwidths, and index of current pointwidth (if it were in the sorted array)
        for (node = streams.head; node !== null; node = node.next) {
            cache = dataCache[node.elem.uuid];
            pointwidths = [];
            for (pointwidth in cache) {
                if (pointwidth != currPWE && cache.hasOwnProperty(pointwidth)) {
                    pointwidths.push(pointwidth);
                }
            }
            pointwidths.sort(function (a, b) { return a - b; });
            j = binSearch(pointwidths, currPWE, function (x) { return x; });
            pwMap[node.elem.uuid] = [pointwidths, j];
        }
        var remaining = true; // There are still pointwidths to remove
        var pwdata, pwcount;
        while (remaining) {
            remaining = false;
            for (node = streams.head; node !== null; node = node.next) {
                uuid = node.elem.uuid;
                pointwidths = pwMap[uuid][0];
                j = pwMap[uuid][1];
                if (pointwidths.length != 0) {
                    remaining = true;
                    if (j > pointwidths.length / 2) {
                        pointwidth = pointwidths.shift();
                        j--;
                    } else {
                        pointwidth = pointwidths.pop();
                    }
                    pwdata = dataCache[uuid][pointwidth];
                    pwcount = 0;
                    for (k = pwdata.length - 1; k >= 0; k--) {
                        pwcount += pwdata[k].getLength();
                        pwdata[k].removeFromSecCache();
                    }
                    delete dataCache[uuid][pointwidth];
                    this.loadedData -= pwcount;
                    loadedStreams[uuid] -= pwcount;
                }
            }
            if (this.loadedData <= target) {
                return true;
            }
        }
        
        // Delete extra cache entries in the current pointwidth, if deleting streams and pointwidths was not enough
        for (node = streams.head; node !== null; node = node.next) {
            pwdata = dataCache[node.elem.uuid][currPWE];
            pwcount = 0;
            for (j = pwdata.length - 1; j >= 0; j--) {
                if ((cmpTimes(pwdata[j].start_time, startTime) <= 0 && cmpTimes(pwdata[j].end_time, endTime) >= 0) || (cmpTimes(pwdata[j].start_time, startTime) >= 0 && cmpTimes(pwdata[j].start_time, endTime) <= 0) || (cmpTimes(pwdata[j].end_time, startTime) >= 0 && cmpTimes(pwdata[j].end_time, endTime) <= 0)) {
                    continue; // This is the cache entry being displayed; we won't delete it
                }
                pwcount += pwdata[j].getLength();
                pwdata[j].removeFromSecCache();
                pwdata.splice(j, 1);
            }
            this.loadedData -= pwcount;
            loadedStreams[node.elem.uuid] -= pwcount;
            if (this.loadedData <= target) {
                return true;
            }
        }
        
        // If target is still less than loadedData, it means that target isn't big enough to accomodate the current cache entry
        return true;
    };
 
/* This is some WebGL stuff that isn't being used anymore.

CacheEntry.leftDir = new THREE.Vector3(-1, 0, 0);
CacheEntry.rightDir = new THREE.Vector3(1, 0, 0);
CacheEntry.topDir = new THREE.Vector3(0, 1, 0);
CacheEntry.bottomDir = new THREE.Vector3(0, -1, 0);
CacheEntry.leftDirMarked = new THREE.Vector3(-1, 0, -1);
CacheEntry.rightDirMarked = new THREE.Vector3(1, 0, -1);
CacheEntry.topDirMarked = new THREE.Vector3(0, 1, -1);
CacheEntry.bottomDirMarked = new THREE.Vector3(0, -1, -1);
CacheEntry.prototype.cacheDrawing = function (pwe) {
        var cacheEntry = this;
        var graph = {vertices: [], faces: []};
        var rangegraph = {vertices: [], faces: []};
        var ddplot = {vertices: [], faces: []};
        var data = cacheEntry.cached_data;
        var vertexID = 0;
        var rangeVertexID = 0;
        var ddplotVertexID = 0;
        var vertexVect;
        var ddplotVertex;
        var range1, range2;
        var timeNanos = [];
        var normal;
        var normals = [];
        var rangeTimeNanos = [];
        var rangePerturb = [];
        var ddplotNanos = [];
        var ddplotnormals = [];
        var shader, rangeShader;
        var ddplotMax = 0;
        var i, j, k;
        var prevI, prevK;
        var pt, prevPt;
        var prevGap = false;
        var gapThreshold = expToPW(pwe);
        var gap;
        var prevCount;
        var endPrevInt;
        prevPt = [cacheEntry.start_time[0], cacheEntry.start_time[1], 0, 0, 0, 0];
        var prevPrevPt;
        
        for (k = 0; k < data.length; k++) {
            for (i = 0; i < data[k].length; i++) {
                pt = data[k][i];
                
                // The x and z coordinates are unused, so we can put the relevent time components there instead of using attribute values
                vertexVect = new THREE.Vector3(Math.floor(pt[0] / 1000000), pt[3], pt[0] % 1000000);
                
                for (j = 0; j < 4; j++) {
                    // These are reference copies, but that's OK since it gets sent to the vertex shader
                    graph.vertices.push(vertexVect);
                    timeNanos.push(pt[1]);
                }
                
                range1 = new THREE.Vector3(Math.floor(pt[0] / 1000000), pt[2], pt[0] % 1000000);
                range2 = new THREE.Vector3(Math.floor(pt[0] / 1000000), pt[4], pt[0] % 1000000);
                rangegraph.vertices.push(range1);
                rangegraph.vertices.push(range2);
                
                rangeTimeNanos.push(pt[1]);
                rangeTimeNanos.push(pt[1]);
                
                rangeVertexID += 2;
                
                vertexID += 4;
                
                gap = cmpTimes(subTimes(pt.slice(0, 2), prevPt), gapThreshold) > 0;
                
                if (i == 0 && k == 0) {
                    normals.push(Cache.zNormal);
                    normals.push(Cache.zNormal);
                    if (gap) {
                        ddplotVertexID = addDDSeg(pt, prevPt, null, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID);
                    }
                    rangePerturb.push(0, 0);
                } else {
                    tempTime = subTimes(pt.slice(0, 2), prevPt);
                    normal = new THREE.Vector3(1000000 * tempTime[0] + tempTime[1], pt[3] - prevPt[3], 0);
                    // Again, reference copies are OK because it gets sent to the vertex shader
                    normals.push(normal);
                    normals.push(normal.clone());
                    normals.push(normal);
                    normals.push(normals[vertexID - 5]);
                    normals[vertexID - 5].negate();
                    
                    // It seems that faces only show up if you traverse their vertices counterclockwise
                    if (gap) {
                        if (prevGap) {
                            normals[vertexID - 8] = CacheEntry.topDirMarked;
                            normals[vertexID - 7] = CacheEntry.bottomDirMarked;
                            normals[vertexID - 6] = CacheEntry.rightDirMarked;
                            normals[vertexID - 5] = CacheEntry.leftDirMarked;
                        }
                    } else {
                        graph.faces.push(new THREE.Face3(vertexID - 6, vertexID - 5, vertexID - 4));
                        graph.faces.push(new THREE.Face3(vertexID - 4, vertexID - 5, vertexID - 3));
                    }
                    graph.faces.push(new THREE.Face3(vertexID - 8, vertexID - 7, vertexID - 6));
                    graph.faces.push(new THREE.Face3(vertexID - 8, vertexID - 5, vertexID - 7));
                    
                    if (gap) {
                        if (prevGap && prevPt[2] != prevPt[4]) {
                            // We'll have to perturb things a bit to get a visibly thick vertical line
                            rangegraph.vertices.pop();
                            rangegraph.vertices.pop();
                            rangePerturb.pop();
                            rangePerturb.pop();
                            rangegraph.vertices.push(rangegraph.vertices[rangegraph.vertices.length - 2]);
                            rangegraph.vertices.push(rangegraph.vertices[rangegraph.vertices.length - 1]);
                            rangeVertexID += 2;
                            rangegraph.faces.push(new THREE.Face3(rangeVertexID - 4, rangeVertexID - 1, rangeVertexID - 3));
                            rangegraph.faces.push(new THREE.Face3(rangeVertexID - 2, rangeVertexID - 1, rangeVertexID - 4));
                            rangegraph.vertices.push(range1);
                            rangegraph.vertices.push(range2);
                            rangePerturb.push(-1, -1, 1, 1, 0, 0);
                        } else {
                            rangePerturb.push(0, 0);
                        }
                    } else {
                        rangegraph.faces.push(new THREE.Face3(rangeVertexID - 4, rangeVertexID - 1, rangeVertexID - 3));
                        rangegraph.faces.push(new THREE.Face3(rangeVertexID - 2, rangeVertexID - 1, rangeVertexID - 4));
                        rangePerturb.push(0, 0);
                    }
                    
                    ddplotMax = Math.max(prevPt[5], ddplotMax);
                    if (gap) {
                        // We ought to zero the ddplot for the appropriate time interval
                        endPrevInt = addTimes([prevPt[0], prevPt[1], 0, 0, 0, 0], gapThreshold);
                        ddplotVertexID = addDDSeg(endPrevInt, prevPt, prevPrevPt, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID);
                        prevPrevPt = prevPt;
                        prevPt = endPrevInt;
                    }
                    ddplotVertexID = addDDSeg(pt, prevPt, prevPrevPt, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID);
                }
                
                prevPrevPt = prevPt
                prevPt = pt;
                prevI = i;
                prevK = k;
                prevGap = gap;
            }
        }
        
        // Deal with last point
        pt = [cacheEntry.end_time[0], cacheEntry.end_time[1], 0, 0, 0, 0];
        gap = cmpTimes(subTimes(pt.slice(0, 2), prevPt), gapThreshold) > 0;
        ddplotMax = Math.max(prevPt[5], ddplotMax);
        if (gap) {
            // We ought to zero the ddplot for the appropriate time interval
            endPrevInt = addTimes([prevPt[0], prevPt[1], 0, 0, 0, 0], gapThreshold);
            ddplotVertexID = addDDSeg(endPrevInt, prevPt, prevPrevPt, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID);
            prevPrevPt = prevPt;
            prevPt = endPrevInt;
        }
        ddplotVertexID = addDDSeg(pt, prevPt, prevPrevPt, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID);
        
        if (prevGap) {
            normals[vertexID - 4] = CacheEntry.topDirMarked;
            normals[vertexID - 3] = CacheEntry.bottomDirMarked;
            normals[vertexID - 2] = CacheEntry.rightDirMarked;
            normals[vertexID - 1] = CacheEntry.leftDirMarked;
        }
        graph.faces.push(new THREE.Face3(vertexID - 4, vertexID - 3, vertexID - 2));
        graph.faces.push(new THREE.Face3(vertexID - 4, vertexID - 1, vertexID - 3));
        
        if (prevGap && prevPt[2] != prevPt[4]) {
            // We'll have to perturb things a bit to get a visibly thick vertical line
            rangegraph.vertices.push(rangegraph.vertices[rangegraph.vertices.length - 2]);
            rangegraph.vertices.push(rangegraph.vertices[rangegraph.vertices.length - 1]);
            rangeVertexID += 2;
            rangegraph.faces.push(new THREE.Face3(rangeVertexID - 4, rangeVertexID - 1, rangeVertexID - 3));
            rangegraph.faces.push(new THREE.Face3(rangeVertexID - 2, rangeVertexID - 1, rangeVertexID - 4));
            rangePerturb.push(-1, -1, 1, 1);
        }
        
        normals.push(Cache.zNormal);
        normals.push(Cache.zNormal);
        
        cacheEntry.cached_drawing.pwe = pwe;
        cacheEntry.cached_drawing.graph = makeBufferGeometry(graph.vertices, graph.faces, normals, timeNanos, false);
        cacheEntry.cached_drawing.rangegraph = makeBufferGeometry(rangegraph.vertices, rangegraph.faces, rangePerturb, rangeTimeNanos, true);
        cacheEntry.cached_drawing.ddplot = makeBufferGeometry(ddplot.vertices, ddplot.faces, ddplotnormals, ddplotNanos, false);
        cacheEntry.cached_drawing.normals = normals;
        cacheEntry.cached_drawing.timeNanos = timeNanos;
        cacheEntry.cached_drawing.rangeTimeNanos = rangeTimeNanos;
        cacheEntry.cached_drawing.rangePerturb = rangePerturb;
        cacheEntry.cached_drawing.ddplotnormals = ddplotnormals;
        cacheEntry.cached_drawing.ddplotNanos = ddplotNanos;
        cacheEntry.cached_drawing.ddplotMax = ddplotMax;
    };
    
function addDDSeg(pt, prevPt, prevPrevPt, ddplot, ddplotNanos, ddplotnormals, ddplotVertexID) {
    var j;
    var ddplotVertex = new THREE.Vector3(Math.floor(prevPt[0] / 1000000), prevPt[5], prevPt[0] % 1000000);
    for (j = 0; j < 4; j++) {
        ddplot.vertices.push(ddplotVertex);
        ddplotNanos.push(prevPt[1]);
    }
    ddplotnormals.push(CacheEntry.topDir);
    ddplotnormals.push(CacheEntry.bottomDir);
    ddplotnormals.push(CacheEntry.leftDir);
    ddplotnormals.push(CacheEntry.rightDir);
    ddplotVertex = new THREE.Vector3(Math.floor(pt[0] / 1000000), prevPt[5], pt[0] % 1000000);
    for (j = 0; j < 4; j++) {
        ddplot.vertices.push(ddplotVertex);
        ddplotNanos.push(pt[1]);
    }
    ddplotnormals.push(CacheEntry.topDir);
    ddplotnormals.push(CacheEntry.bottomDir);
    ddplotnormals.push(CacheEntry.leftDir);
    ddplotnormals.push(CacheEntry.rightDir);
    ddplotVertexID += 8;
    if (ddplotVertexID >= 12) {
        ddplot.faces.push(new THREE.Face3(ddplotVertexID - 9, ddplotVertexID - 12, ddplotVertexID - 11));
        if (prevPt[5] > prevPrevPt[5]) {
            ddplot.faces.push(new THREE.Face3(ddplotVertexID - 6, ddplotVertexID - 10, ddplotVertexID - 5));
            ddplot.faces.push(new THREE.Face3(ddplotVertexID - 10, ddplotVertexID - 9, ddplotVertexID - 5));
        } else if (prevPt[5] < prevPrevPt[5]) {
            ddplot.faces.push(new THREE.Face3(ddplotVertexID - 6, ddplotVertexID - 5, ddplotVertexID - 10));
            ddplot.faces.push(new THREE.Face3(ddplotVertexID - 10, ddplotVertexID - 5, ddplotVertexID - 9));
        }
        ddplot.faces.push(new THREE.Face3(ddplotVertexID - 8, ddplotVertexID - 6, ddplotVertexID - 7));
    }
    ddplot.faces.push(new THREE.Face3(ddplotVertexID - 8, ddplotVertexID - 7, ddplotVertexID - 4));
    ddplot.faces.push(new THREE.Face3(ddplotVertexID - 7, ddplotVertexID - 3, ddplotVertexID - 4));
    
    return ddplotVertexID;
}

Cache.makeShaders = function () {
        var shader = new THREE.ShaderMaterial({
            uniforms: {
                "affineMatrix": {type: 'm4'},
                "color": {type: 'v3'},
                "thickness": {type: 'f'},
                "yDomainLo": {type: 'f'},
                "xDomainLo1000": {type: 'f'},
                "xDomainLoMillis": {type: 'f'},
                "xDomainLoNanos": {type: 'f'},
                "horizPixelShift": {type: 'f'},
                },
            attributes: {
                "normalVector": {type: 'v3'},
                "timeNanos": {type: 'f'}
                },
            vertexShader: " \
                uniform mat4 affineMatrix; \
                uniform mat3 rot90Matrix; \
                uniform float thickness; \
                uniform float yDomainLo; \
                uniform float xDomainLo1000; \
                uniform float xDomainLoMillis; \
                uniform float xDomainLoNanos; \
                uniform float horizPixelShift; \
                attribute vec3 normalVector; \
                attribute float timeNanos; \
                float trueThickness; \
                vec3 trueNormal; \
                void main() { \
                    if (normalVector.z < 0.0) { \
                        trueThickness = 2.5 * thickness; \
                        trueNormal = vec3(normalVector.x, normalVector.y, 0.0); \
                    } else { \
                        trueThickness = thickness; \
                        trueNormal = normalVector; \
                    } \
                    float xDiff = 1000000000000.0 * (position.x - xDomainLo1000) + 1000000.0 * (position.z - xDomainLoMillis) + (timeNanos - xDomainLoNanos); \
                    vec4 newPosition = affineMatrix * vec4(xDiff, position.y - yDomainLo, 0.0, 1.0) + vec4(trueThickness * normalize(cross(vec3(0, 0, 1), mat3(affineMatrix) * trueNormal)), 0.0); \
                    newPosition.x += horizPixelShift; \
                    gl_Position = projectionMatrix * modelViewMatrix * newPosition; \
                 } \
                 ",
            fragmentShader: "\
                uniform vec3 color; \
                void main() { \
                    gl_FragColor = vec4(color, 1.0); \
                } \
                "
            });
            
            // vec4 newPosition = affineMatrix * vec4(truePosition, 1.0) + vec4(trueThickness * normalize(rot90Matrix * mat3(affineMatrix) * trueNormal), 0.0); \ is what one of the lines used to be. I switched it to a cross product. truePosition was vec3(xDiff, position.y - yDomainLo, 0.0)
        
        var rangeshader = new THREE.ShaderMaterial({
                uniforms: {
                    "affineMatrix": {type: 'm4'},
                    "color": {type: 'v3'},
                    "thickness": {type: 'f'},
                    "alpha": {type: 'f'},
                    "yDomainLo": {type: 'f'},
                    "xDomainLo1000": {type: 'f'},
                    "xDomainLoMillis": {type: 'f'},
                    "xDomainLoNanos": {type: 'f'},
                    "horizPixelShift": {type: 'f'}
                    },
                attributes: {
                    "timeNanos": {type: 'f'},
                    "rangePerturb": {type: 'f'}
                    },
                vertexShader: " \
                    uniform mat4 affineMatrix; \
                    uniform float thickness; \
                    uniform float yDomainLo; \
                    uniform float xDomainLo1000; \
                    uniform float xDomainLoMillis; \
                    uniform float xDomainLoNanos; \
                    uniform float horizPixelShift; \
                    attribute float timeNanos; \
                    attribute float rangePerturb; \
                    void main() { \
                        float xDiff = 1000000000000.0 * (position.x - xDomainLo1000) + 1000000.0 * (position.z - xDomainLoMillis) + (timeNanos - xDomainLoNanos); \
                        vec4 newPosition = affineMatrix * vec4(xDiff, position.y - yDomainLo, 0.0, 1.0); \
                        newPosition.x += (horizPixelShift + rangePerturb * thickness); \
                        gl_Position = projectionMatrix * modelViewMatrix * newPosition; \
                     } \
                     ",
                fragmentShader: "\
                    uniform vec3 color; \
                    uniform float alpha; \
                    void main() { \
                        gl_FragColor = vec4(color, alpha); \
                    } \
                    "
                });
                
        rangeshader.transparent = true;
        
        var ddplotshader = new THREE.ShaderMaterial({
            uniforms: {
                "affineMatrix": {type: 'm4'},
                "color": {type: 'v3'},
                "thickness": {type: 'f'},
                "yDomainLo": {type: 'f'},
                "xDomainLo1000": {type: 'f'},
                "xDomainLoMillis": {type: 'f'},
                "xDomainLoNanos": {type: 'f'}
                },
            attributes: {
                "normalVector": {type: 'v3'},
                "timeNanos": {type: 'f'}
                },
            vertexShader: " \
                uniform mat4 affineMatrix; \
                uniform float thickness; \
                uniform float yDomainLo; \
                uniform float xDomainLo1000; \
                uniform float xDomainLoMillis; \
                uniform float xDomainLoNanos; \
                attribute vec3 normalVector; \
                attribute float timeNanos; \
                void main() { \
                    float xDiff = 1000000000000.0 * (position.x - xDomainLo1000) + 1000000.0 * (position.z - xDomainLoMillis) + (timeNanos - xDomainLoNanos); \
                    vec3 truePosition = vec3(xDiff, position.y - yDomainLo, 0.0); \
                    vec4 newPosition = affineMatrix * vec4(truePosition, 1.0) + vec4(thickness * normalize(mat3(affineMatrix) * normalVector), 0.0); \
                    gl_Position = projectionMatrix * modelViewMatrix * newPosition; \
                 } \
                 ",
            fragmentShader: "\
                uniform vec3 color; \
                void main() { \
                    gl_FragColor = vec4(color, 1.0); \
                } \
                "
            });
                
        return [shader, rangeshader, ddplotshader];
    };
    
function FacePool() {
    this.faces = [true, true, true, true, true, true, true, true];
}

FacePool.prototype.fillArr = function (arr, vStart, vEnd) {
        var i = vStart;
        if (vEnd < this.faces.length) {
            while (i < vEnd) {
                arr.push(this.faces[i]);
                arr.push(this.faces[i + 1]);
                arr.push(this.faces[i + 2]);
                arr.push(this.faces[i + 3]);
                i += 4;
            }
            return;
        }
        while (i < this.faces.length) {
            arr.push(this.faces[i]);
            arr.push(this.faces[i + 1]);
            arr.push(this.faces[i + 2]);
            arr.push(this.faces[i + 3]);
            i += 4;
        }
        while (i < vEnd) {
            this.faces.push(new THREE.Face3(i - 6, i - 5, i - 4));
            this.faces.push(new THREE.Face3(i - 4, i - 5, i - 3));
            this.faces.push(new THREE.Face3(i - 8, i - 7, i - 6));
            this.faces.push(new THREE.Face3(i - 8, i - 5, i - 7));
            arr.push(this.faces[i]);
            arr.push(this.faces[i + 1]);
            arr.push(this.faces[i + 2]);
            arr.push(this.faces[i + 3]);
            i += 4;
        }
    };
*/

/* Performs binary search on SORTEDLST to find the index of item whose key is
   ITEM. KEY is a function that takes an element of the list as an argument and
   returns its key. If ITEM is not the key of any of the items in SORTEDLST,
   one of the indices closest to the index where it would be is returned. */
function binSearch(sortedLst, item, key) {
    var currVal;
    var low = 0;
    var high = sortedLst.length - 1;
    var i;
    while (low < high) {
        i = Math.floor((low + high) / 2);
        currVal = key(sortedLst[i]);
        if (currVal < item) {
            low = i + 1;
        } else if (currVal > item) {
            high = i - 1;
        } else {
            return i;
        }
    }
    return low;
}

/* Performs binary search of SORTEDLST to find the index of the item that,
   according to the comparator, is equal to ITEM. COMPARATOR is a function
   that, given two elements in the array, returns a negative number of the
   first is less than the second, a positive number if it is greater, and
   zero if the two are equal. If ITEM is not equal to any of the items in
   SORTEDLST, one of the indices closes to the index where it would be is
   returned. */
function binSearchCmp(sortedLst, item, comparator) {
    var comparison;
    var low = 0;
    var high = sortedLst.length - 1;
    var i;
    while (low < high) {
        i = Math.floor((low + high) / 2);
        comparison = comparator(sortedLst[i], item);
        if (comparison < 0) {
            low = i + 1;
        } else if (comparison > 0) {
            high = i - 1;
        } else {
            return i;
        }
    }
    return low;
}

function cmpTimes(t1, t2) {
    if (t1[0] < t2[0]) {
        return -1;
    } else if (t1[0] > t2[0]) {
        return 1;
    } else if (t1[1] < t2[1]) {
        return -1;
    } else if (t1[1] > t2[1]) {
        return 1;
    } else {
        return 0;
    }
}

function addTimes(time, toAdd) {
    time[0] += toAdd[0]
    time[1] += toAdd[1];
    if (time[1] >= 1000000) {
        time[0] += 1;
        time[1] -= 1000000;
    }
    return time;
}

function subTimes(time, toSub) {
    time[0] -= toSub[0];
    time[1] -= toSub[1];
    if (time[1] < 0) {
        time[0] -= 1;
        time[1] += 1000000;
    }
    return time;
}

function mulTime(time, c) {
    time[0] *= c;
    time[1] *= c;
    var intMillis = Math.floor(time[0]);
    var fracMillis = time[0] - intMillis;
    time[0] = intMillis;
    time[1] += 1000000 * fracMillis;
    intMillis = Math.floor(time[1] / 1000000);
    time[0] += intMillis;
    time[1] -= 1000000 * intMillis;
    return time;
}

function timeToStr(time) {
    if (time[0] > 0) {
        return time[0] + (1000000 + time[1]).toString().slice(1);
    } else if (time[0] < 0) {
        return (time[0] + 1) + (2000000 - time[1]).toString().slice(1);
    } else {
        return time[1].toString();
    }
}

function boundToRange(time, low, high) {
    if (cmpTimes(time, low) < 0) {
        return low;
    }
    if (cmpTimes(time, high) > 0) {
        return high;
    }
    return time;
}

function roundTime(time) {
    time[1] = Math.round(time[1]);
    if (time[1] == 1000000) {
        time[0]++;
        time[1] = 0;
    }
    return time;
}

/* Modifying the output of this function could seriously mess things up. */
function expToPW(pwe) {
    // I guess I could use repeated squaring to do this efficiently
    // But looking it up in an array is certainly faster
    return pws[pwe + 1];
}

/* NANOS is the number of nanoseconds in an interval, expressed as an array
   of two numbers. Returns the number x such that 2 ^ x <= nanos
   but 2 ^ (x + 1) > nanos. */
function getPWExponent(nanos) {
    var index = binSearchCmp(pws, nanos, cmpTimes);
    if (cmpTimes(pws[index], nanos) > 0) {
        index -= 2;
    } else if (index > 1) {
        index -= 1;
    }
    
    if (index <= 0) {
        return 0;
    }
    return index;
}

var pws = [[0, 0.5], [0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [0, 32], [0, 64], [0, 128], [0, 256], [0, 512], [0, 1024], [0, 2048], [0, 4096], [0, 8192], [0, 16384], [0, 32768], [0, 65536], [0, 131072], [0, 262144], [0, 524288], [1, 48576], [2, 97152], [4, 194304], [8, 388608], [16, 777216], [33, 554432], [67, 108864], [134, 217728], [268, 435456], [536, 870912], [1073, 741824], [2147, 483648], [4294, 967296], [8589, 934592], [17179, 869184], [34359, 738368], [68719, 476736], [137438, 953472], [274877, 906944], [549755, 813888], [1099511, 627776], [2199023, 255552], [4398046, 511104], [8796093, 22208], [17592186, 44416], [35184372, 88832], [70368744, 177664], [140737488, 355328], [281474976, 710656], [562949953, 421312], [1125899906, 842624], [2251799813, 685248], [4503599627, 370496], [9007199254, 740992], [18014398509, 481984], [36028797018, 963968], [72057594037, 927936], [144115188075, 855872], [288230376151, 711744], [576460752303, 423488], [1152921504606, 846976], [2305843009213, 693952], [4611686018427, 387904]];
