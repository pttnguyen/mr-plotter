package main

import (
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
	
	cpint "github.com/SoftwareDefinedBuildings/btrdb/cpinterface"
	capnp "github.com/glycerine/go-capnproto"
	uuid "github.com/pborman/uuid"
	ws "github.com/gorilla/websocket"
)

const (
	QUASAR_LOW int64 = 1 - (16 << 56)
	QUASAR_HIGH int64 = (48 << 56) - 1
	INVALID_TIME int64 = -0x8000000000000000
)

func splitTime(time int64) (millis int64, nanos int32) {
	millis = time / 1000000
	nanos = int32(time % 1000000)
	if nanos < 0 {
		nanos += 1000000
		millis++
	}
	return
}

type QueryMessagePart struct {
	segment *capnp.Segment
	request *cpint.Request
	query *cpint.CmdQueryStatisticalValues
}

var queryPool sync.Pool = sync.Pool{
	New: func () interface{} {
		var seg *capnp.Segment = capnp.NewBuffer(nil)
		var req cpint.Request = cpint.NewRootRequest(seg)
		var query cpint.CmdQueryStatisticalValues = cpint.NewCmdQueryStatisticalValues(seg)
		query.SetVersion(0)
		return QueryMessagePart{
			segment: seg,
			request: &req,
			query: &query,
		}
	},
}

type BracketMessagePart struct {
	segment *capnp.Segment
	request *cpint.Request
	bquery *cpint.CmdQueryNearestValue
}

var bracketPool sync.Pool = sync.Pool{
	New: func () interface{} {
		var seg *capnp.Segment = capnp.NewBuffer(nil)
		var req cpint.Request = cpint.NewRootRequest(seg)
		var bquery cpint.CmdQueryNearestValue = cpint.NewCmdQueryNearestValue(seg)
		bquery.SetVersion(0)
		return BracketMessagePart{
			segment: seg,
			request: &req,
			bquery: &bquery,
		}
	},
}

type Writable interface {
	GetWriter () io.Writer
}

type ConnWrapper struct {
	Writing *sync.Mutex
	Conn *ws.Conn
	CurrWriter io.WriteCloser
}

func (cw *ConnWrapper) GetWriter() io.Writer {
	cw.Writing.Lock()
	w, err := cw.Conn.NextWriter(ws.TextMessage)
	if err == nil {
		cw.CurrWriter = w
		return w
	} else {
		fmt.Printf("Could not get writer on WebSocket: %v", err)
		return nil
	}
}

/** DataRequester encapsulates a series of connections used for obtaining data
	from QUASAR. */
type DataRequester struct {
	connections []net.Conn
	sendLocks []*sync.Mutex
	currID uint64
	connID uint32
	pending uint32
	maxPending uint32
	pendingLock *sync.Mutex
	responseWriters map[uint64]Writable
	synchronizers map[uint64]chan bool
	gotFirstSeg map[uint64]bool
	boundaries map[uint64]int64
	alive bool
}

/** Creates a new DataRequester object.
	dbAddr - the address of the database from where to obtain data.
	numConnections - the number of connections to use.
	maxPending - a limit on the maximum number of pending requests.
	bracket - whether or not the new DataRequester will be used for bracket calls. */
func NewDataRequester(dbAddr string, numConnections int, maxPending uint32, bracket bool) *DataRequester {
	var connections []net.Conn = make([]net.Conn, numConnections)
	var locks []*sync.Mutex = make([]*sync.Mutex, numConnections)
	var err error
	var i int
	for i = 0; i < numConnections; i++ {
		connections[i], err = net.Dial("tcp", dbAddr)
		if err != nil {
			fmt.Printf("Could not connect to database at %v: %v\n", dbAddr, err)
			return nil
		}
		locks[i] = &sync.Mutex{}
	}
	
	var dr *DataRequester = &DataRequester{
		connections: connections,
		sendLocks: locks,
		currID: 0,
		connID: 0,
		pending: 0,
		maxPending: maxPending,
		pendingLock: &sync.Mutex{},
		responseWriters: make(map[uint64]Writable),
		synchronizers: make(map[uint64]chan bool),
		gotFirstSeg: make(map[uint64]bool),
		boundaries: make(map[uint64]int64),
		alive: true,
	}
	
	var responseHandler func(net.Conn)
	if bracket {
		responseHandler = dr.handleBracketResponse
	} else {
		responseHandler = dr.handleDataResponse
	}
	
	for i = 0; i < numConnections; i++ {
		go responseHandler(connections[i])
	}
	
	return dr
}

/* Makes a request for data and writes the result to the specified Writer. */
func (dr *DataRequester) MakeDataRequest(uuidBytes uuid.UUID, startTime int64, endTime int64, pw uint8, writ Writable) {
	for true {
		dr.pendingLock.Lock()
		if dr.pending < dr.maxPending {
			dr.pending += 1
			dr.pendingLock.Unlock()
			break
		} else {
			dr.pendingLock.Unlock()
			time.Sleep(time.Second)
		}
	}
	
	defer atomic.AddUint32(&dr.pending, 0xFFFFFFFF)
	
	var mp QueryMessagePart = queryPool.Get().(QueryMessagePart)
	
	segment := mp.segment
	request := mp.request
	query := mp.query
	
	query.SetUuid([]byte(uuidBytes))
	query.SetStartTime(startTime)
	query.SetEndTime(endTime)
	query.SetPointWidth(pw)
	
	id := atomic.AddUint64(&dr.currID, 1)
	
	request.SetEchoTag(id)
	
	request.SetQueryStatisticalValues(*query)
	
	cid := atomic.AddUint32(&dr.connID, 1) % uint32(len(dr.connections))
	
	dr.sendLocks[cid].Lock()
	dr.responseWriters[id] = writ
	dr.synchronizers[id] = make(chan bool)
	dr.gotFirstSeg[id] = false
	_, sendErr := segment.WriteTo(dr.connections[cid])
	dr.sendLocks[cid].Unlock()
	
	defer delete(dr.responseWriters, id)
	defer delete(dr.synchronizers, id)
	defer delete(dr.gotFirstSeg, id)
	
	queryPool.Put(mp)
	
	if sendErr != nil {
		w := writ.GetWriter()
		w.Write([]byte(fmt.Sprintf("Could not send query to database: %v", sendErr)))
		return
	}
	
	<- dr.synchronizers[id]
}

/** A function designed to handle QUASAR's response over Cap'n Proto.
	You shouldn't ever have to invoke this function. It is used internally by
	the constructor function. */
func (dr *DataRequester) handleDataResponse(connection net.Conn) {
	for dr.alive {
		// Only one goroutine will be reading at a time, so a lock isn't needed
		responseSegment, respErr := capnp.ReadFromStream(connection, nil)
		
		if respErr != nil {
			if !dr.alive {
				break
			}
			fmt.Printf("Error in receiving response: %v\n", respErr)
			continue
		}
		
		responseSeg := cpint.ReadRootResponse(responseSegment)
		id := responseSeg.EchoTag()
		status := responseSeg.StatusCode()
		records := responseSeg.StatisticalRecords().Values()
		final := responseSeg.Final()
		
		firstSeg := !dr.gotFirstSeg[id]
		writ := dr.responseWriters[id]
		
		dr.gotFirstSeg[id] = true
		
		w := writ.GetWriter()
		
		if status != cpint.STATUSCODE_OK {
			fmt.Printf("Bad status code: %v\n", status)
			w.Write([]byte(fmt.Sprintf("Database returns status code %v", status)))
			if final {
				dr.synchronizers[id] <- false
			}
			continue
		}
		
		length := records.Len()
		
		if firstSeg {
			w.Write([]byte("["))
		}
		for i := 0; i < length; i++ {
			record := records.At(i)
			millis, nanos := splitTime(record.Time())
			if firstSeg && i == 0 {
				w.Write([]byte(fmt.Sprintf("[%v,%v,%v,%v,%v,%v]", millis, nanos, record.Min(), record.Mean(), record.Max(), record.Count())))
			} else {
				w.Write([]byte(fmt.Sprintf(",[%v,%v,%v,%v,%v,%v]", millis, nanos, record.Min(), record.Mean(), record.Max(), record.Count())))
			}
		}
		
		if final {
			w.Write([]byte("]"))
		}
		
		if final {
			dr.synchronizers[id] <- true
		}
	}
}

func (dr *DataRequester) MakeBracketRequest(uuids []uuid.UUID, writ Writable) {
	for true {
		dr.pendingLock.Lock()
		if dr.pending < dr.maxPending {
			dr.pending += 1
			dr.pendingLock.Unlock()
			break
		} else {
			dr.pendingLock.Unlock()
			time.Sleep(time.Second)
		}
	}
	
	defer atomic.AddUint32(&dr.pending, 0xFFFFFFFF)
	
	var mp BracketMessagePart = bracketPool.Get().(BracketMessagePart)
	
	segment := mp.segment
	request := mp.request
	bquery := mp.bquery
	
	var numResponses int = 2 * len(uuids)
	var responseChan chan bool = make(chan bool, numResponses)
	
	var idsUsed []uint64 = make([]uint64, numResponses) // Due to concurrency, we could use a non-contiguous block of IDs
	
	var i int
	var id uint64
	var cid uint32
	var sendErr error
	for i = 0; i < len(uuids); i++ {
		bquery.SetUuid([]byte(uuids[i]))
		bquery.SetTime(QUASAR_LOW)
		bquery.SetBackward(false)
	
		id = atomic.AddUint64(&dr.currID, 1)
		idsUsed[i << 1] = id
		dr.boundaries[id] = INVALID_TIME
	
		request.SetEchoTag(id)
	
		request.SetQueryNearestValue(*bquery)
	
		cid = atomic.AddUint32(&dr.connID, 1) % uint32(len(dr.connections))
	
		dr.sendLocks[cid].Lock()
		dr.responseWriters[id] = writ
		dr.synchronizers[id] = responseChan
		_, sendErr = segment.WriteTo(dr.connections[cid])
		dr.sendLocks[cid].Unlock()
		
		defer delete(dr.responseWriters, id)
		defer delete(dr.synchronizers, id)
		defer delete(dr.boundaries, id)
		
		if sendErr != nil {
			w := writ.GetWriter()
			w.Write([]byte(fmt.Sprintf("Could not send query to database: %v", sendErr)))
			return
		}
		
		bquery.SetTime(QUASAR_HIGH)
		bquery.SetBackward(true)
		
		id = atomic.AddUint64(&dr.currID, 1)
		idsUsed[(i << 1) + 1] = id
		dr.boundaries[id] = INVALID_TIME
	
		request.SetEchoTag(id)
	
		request.SetQueryNearestValue(*bquery)
	
		cid = atomic.AddUint32(&dr.connID, 1) % uint32(len(dr.connections))
	
		dr.sendLocks[cid].Lock()
		dr.responseWriters[id] = writ
		dr.synchronizers[id] = responseChan
		_, sendErr = segment.WriteTo(dr.connections[cid])
		dr.sendLocks[cid].Unlock()
		
		defer delete(dr.responseWriters, id)
		defer delete(dr.synchronizers, id)
		defer delete(dr.boundaries, id)
		
		if sendErr != nil {
			w := writ.GetWriter()
			w.Write([]byte(fmt.Sprintf("Could not send query to database: %v", sendErr)))
			return
		}
	}
	
	bracketPool.Put(mp)
	
	for i = 0; i < numResponses; i++ {
		<- responseChan
	}
	
	var (
		boundary int64
		lNanos int32
		lMillis int64
		rNanos int32
		rMillis int64
		lowest int64 = QUASAR_HIGH
		highest int64 = QUASAR_LOW
		trailchar rune = ','
	)
	w := writ.GetWriter()
	w.Write([]byte("{\"Brackets\": ["))
	for i = 0; i < len(uuids); i++ {
		boundary = dr.boundaries[idsUsed[i << 1]]
		if boundary != INVALID_TIME && boundary < lowest {
			lowest = boundary
		}
		lMillis, lNanos = splitTime(boundary)
		boundary = dr.boundaries[idsUsed[(i << 1) + 1]]
		if boundary != INVALID_TIME && boundary > highest {
			highest = boundary
		}
		rMillis, rNanos = splitTime(boundary)
		if i == len(uuids) - 1 {
			trailchar = ']';
		}
		w.Write([]byte(fmt.Sprintf("[[%v,%v],[%v,%v]]%c", lMillis, lNanos, rMillis, rNanos, trailchar)))
	}
	lMillis, lNanos = splitTime(lowest)
	rMillis, rNanos = splitTime(highest)
	w.Write([]byte(fmt.Sprintf(",\"Merged\":[[%v,%v],[%v,%v]]}", lMillis, lNanos, rMillis, rNanos)))
}

/** A function designed to handle QUASAR's response over Cap'n Proto.
	You shouldn't ever have to invoke this function. It is used internally by
	the constructor function. */
func (dr *DataRequester) handleBracketResponse(connection net.Conn) {
	for dr.alive {
		// Only one goroutine will be reading at a time, so a lock isn't needed
		responseSegment, respErr := capnp.ReadFromStream(connection, nil)
		
		if respErr != nil {
			if !dr.alive {
				break
			}
			fmt.Printf("Error in receiving response: %v\n", respErr)
			continue
		}
		
		responseSeg := cpint.ReadRootResponse(responseSegment)
		id := responseSeg.EchoTag()
		status := responseSeg.StatusCode()
		records := responseSeg.Records().Values()
		
		if status != cpint.STATUSCODE_OK {
			fmt.Printf("Error in bracket call: database returns status code %v\n", status)
			dr.synchronizers[id] <- false
			continue
		}
		
		if records.Len() > 0 {
			dr.boundaries[id] = records.At(0).Time()
		}
		
		dr.synchronizers[id] <- true
	}
}

func (dr *DataRequester) stop() {
	dr.alive = false
}