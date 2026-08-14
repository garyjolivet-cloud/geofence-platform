/* ble-gps.js — shared BLE GPS bridge (window.BleGPS)
 *
 * Extracted 2026-08-14 from geofence-engine.html (item D, 3D-mode plan,
 * originally the only consumer) so field-recorder.html, geofence-sim.html,
 * and fence-editor.html's Test Mode can all connect the same real hardware
 * instead of re-implementing BLE parsing three more times. Matches the
 * callback-injection shape guidance-bot.js already uses (`start({sayFn,
 * onComplete,...})`/`update()`/`stop()`) rather than reaching for page
 * globals directly — a host page wires it up via `BleGPS.init({...})`
 * before ever calling `connect()`.
 *
 * Supports two protocols, auto-detected on connect:
 *
 *   Protocol A · LNS (Location and Navigation Service, GATT 0x1819)
 *     Works with: dedicated BLE GPS receivers that broadcast the standard
 *     service with no custom pairing app needed.
 *     Characteristic 0x2A67 (Location and Speed) carries packed binary
 *     lat/lon and, when the Elevation flag (bit 3) is set, a signed 24-bit
 *     elevation field (metres × 0.01) right after Location and before
 *     Heading — the spec's own Elevation Source enum (flags bits 10-11:
 *     0=Position System, 1=Barometric, 2=Database, 3=Other) lets a
 *     compliant dongle self-report "this altitude is barometric" with no
 *     custom protocol needed.
 *
 *   Protocol B · NUS (Nordic UART Service)
 *     Works with: any DIY dongle broadcasting text lines over the same
 *     UUIDs. One line per second, CSV, frozen field order (adding fields
 *     is safe, old shorter lines must keep parsing unchanged — firmware
 *     and this parser have no shared schema otherwise):
 *       "lat,lon"                                e.g. 51.302757,-117.054644
 *       "lat,lon,acc_m"
 *       "lat,lon,acc_m,hdg_deg"
 *       "lat,lon,acc_m,hdg_deg,alt_m"            — item D: DIY barometer
 *       "lat,lon,acc_m,hdg_deg,alt_m,alt_acc_m"  — item D: DIY barometer
 *       NMEA $GPRMC sentence
 *       NMEA $GPGGA sentence
 *
 *   Connection flow: scan for both service UUIDs at once → try LNS → fall
 *   back to NUS.
 *
 * Host contract — call BleGPS.init({...}) once before connect():
 *   onStatus(cls, msg)   — cls: 'off'|'scanning'|'connected'|'error', for a status readout
 *   onLog(cls, msg)      — cls: 'ev-sys'|'ev-warn', for an activity log
 *   onFix(fix)           — fix = {lat,lon,acc,t[,heading][,alt,altAcc,altSource]}
 *   onConnected(name, protocol)  — protocol: 'lns'|'nus'; host's cue to stop its own device-GPS watch, update UI
 *   onDisconnected()     — host's cue to reset its own GPS-source UI
 * All callbacks are optional (default no-ops) so a minimal host can just wire onFix.
 */
(function(global){
  const BleGPS = {
    device:null, char:null, active:false, protocol:null,

    // LNS
    LNS_SERVICE: 0x1819,
    LOC_SPEED:   0x2A67,

    // NUS (Nordic UART Service)
    NUS_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_TX:      '6e400003-b5a3-f393-e0a9-e50e24dcca9e',  // watch → phone

    _cb:{ onStatus(){}, onLog(){}, onFix(){}, onConnected(){}, onDisconnected(){} },
    init(cb){ Object.assign(this._cb, cb||{}); },

    async connect(){
      if(!navigator.bluetooth){
        this._cb.onStatus('error','Web Bluetooth not supported — use Chrome or Edge');
        this._cb.onLog('ev-warn','Bluetooth: not supported in this browser'); return;
      }
      try{
        this._cb.onStatus('scanning','Scanning for devices…');
        this.device = await navigator.bluetooth.requestDevice({
          filters:[
            {services:[this.LNS_SERVICE]},
            {services:[this.NUS_SERVICE]}
          ],
          optionalServices:[this.LNS_SERVICE, this.NUS_SERVICE]
        });
        this.device.addEventListener('gattserverdisconnected',()=>this._onDisconnect());
        this._cb.onStatus('scanning','Connecting…');
        const server = await this.device.gatt.connect();

        // Auto-detect protocol: try LNS first, fall back to NUS
        const ok = await this._negotiate(server);
        if(!ok){
          this._cb.onStatus('error','Device found but no GPS service detected');
          this._cb.onLog('ev-warn','BLE GPS: device has neither LNS nor NUS service');
          this.device.gatt.disconnect(); return;
        }

        this.char.addEventListener('characteristicvaluechanged', e=>this._onData(e));
        await this.char.startNotifications();
        this.active = true;
        const name = this.device.name || 'BLE GPS';
        const proto = this.protocol === 'lns' ? 'LNS' : 'NUS/UART';
        this._cb.onStatus('connected','● '+name+'  ·  '+proto);
        this._cb.onLog('ev-sys','BLE GPS connected: '+name+' ('+proto+')');
        this._cb.onConnected(name, proto);
      }catch(e){
        if(e.name==='NotFoundError'){ this._cb.onStatus('off','No device selected'); }
        else{ this._cb.onStatus('error',e.message||'Connection failed');
              this._cb.onLog('ev-warn','BLE GPS: '+(e.message||'connection failed')); }
      }
    },

    // Try LNS first, fall back to NUS; sets this.char + this.protocol
    async _negotiate(server){
      try{
        const svc   = await server.getPrimaryService(this.LNS_SERVICE);
        this.char   = await svc.getCharacteristic(this.LOC_SPEED);
        this.protocol = 'lns'; return true;
      }catch(_){}
      try{
        const svc   = await server.getPrimaryService(this.NUS_SERVICE);
        this.char   = await svc.getCharacteristic(this.NUS_TX);
        this.protocol = 'nus'; return true;
      }catch(_){}
      return false;
    },

    disconnect(){
      if(this.device && this.device.gatt.connected) this.device.gatt.disconnect();
      else this._onDisconnect();
    },

    _onDisconnect(){
      this.active=false; this.char=null; this.device=null; this.protocol=null;
      this._cb.onStatus('off','Disconnected');
      this._cb.onLog('ev-sys','BLE GPS disconnected');
      this._cb.onDisconnected();
    },

    _onData(e){
      if(!this.active) return;
      const fix = this.protocol==='lns' ? this._parseLNS(e.target.value)
                                        : this._parseNUS(e.target.value);
      if(fix) this._cb.onFix(fix);
    },

    // ── Protocol A: LNS binary (GATT 0x2A67) ──────────────────────────
    _parseLNS(dv){
      try{
        if(dv.byteLength<2) return null;
        const flags    = dv.getUint16(0,true);
        const hasSpeed = !!(flags&0x01);
        const hasDist  = !!(flags&0x02);
        const hasLoc   = !!(flags&0x04);
        const hasElev  = !!(flags&0x08);
        const elevSrc  = (flags>>10)&0x3;   // 0=Position System,1=Barometric,2=Database,3=Other (0x2A67 spec)
        if(!hasLoc) return null;
        let o=2;
        if(hasSpeed) o+=2;   // uint16 × 0.01 m/s
        if(hasDist)  o+=3;   // uint24
        if(dv.byteLength<o+8) return null;
        const lat = dv.getInt32(o,true)*1e-7; o+=4;
        const lon = dv.getInt32(o,true)*1e-7; o+=4;
        if(lat<-90||lat>90||lon<-180||lon>180) return null;
        const fix={lat,lon,acc:5,t:Date.now()};
        // Elevation: signed 24-bit, metres × 0.01. elevSrc===1 (Barometric)
        // is the whole point of a BLE dongle — tag "baro" for the EKF's
        // tight trust tier; other sources (GPS/database/other) are no
        // better than the phone's own altitude, tagged "gps" so they get
        // the loose tier instead of falsely inheriting barometric trust.
        if(hasElev && dv.byteLength>=o+3){
          const b0=dv.getUint8(o), b1=dv.getUint8(o+1), b2=dv.getUint8(o+2);
          let raw = b0 | (b1<<8) | (b2<<16);
          if(raw & 0x800000) raw -= 0x1000000;
          fix.alt = raw*0.01;
          fix.altSource = elevSrc===1 ? 'baro' : 'gps';
        }
        return fix;
      }catch(e){ return null; }
    },

    // ── Protocol B: NUS text (UART) ──────────────────────
    _parseNUS(dv){
      try{
        const line = new TextDecoder().decode(dv).trim();
        if(!line) return null;
        if(line.startsWith('$GPRMC')) return this._rmc(line);
        if(line.startsWith('$GPGGA')) return this._gga(line);
        // simple CSV
        const p = line.split(',');
        if(p.length<2) return null;
        const lat=parseFloat(p[0]), lon=parseFloat(p[1]);
        const acc=p.length>=3 ? parseFloat(p[2]) : 5;
        const hdg=p.length>=4 ? parseFloat(p[3]) : null;
        if(!isFinite(lat)||!isFinite(lon)||lat<-90||lat>90||lon<-180||lon>180) return null;
        const fix={lat,lon,acc:isFinite(acc)?acc:5,t:Date.now()};
        if(hdg!==null && isFinite(hdg) && hdg>=0 && hdg<360) fix.heading=hdg;
        if(p.length>=5){
          const alt=parseFloat(p[4]);
          if(isFinite(alt)){
            fix.alt=alt; fix.altSource='baro';
            if(p.length>=6){ const aAcc=parseFloat(p[5]); if(isFinite(aAcc)) fix.altAcc=aAcc; }
          }
        }
        return fix;
      }catch(e){ return null; }
    },

    // $GPRMC,hhmmss,A,ddmm.mmm,N,dddmm.mmm,E,speed,course,date,...
    _rmc(s){
      const f=s.split(',');
      if(f.length<7||f[2]!=='A') return null;   // void fix
      const lat=this._nd(f[3],f[4]), lon=this._nd(f[5],f[6]);
      if(lat===null||lon===null) return null;
      return {lat,lon,acc:5,t:Date.now()};
    },

    // $GPGGA,hhmmss,ddmm.mmm,N,dddmm.mmm,E,quality,sats,hdop,...
    _gga(s){
      const f=s.split(',');
      if(f.length<10||f[6]==='0') return null;   // no fix
      const lat=this._nd(f[2],f[3]), lon=this._nd(f[4],f[5]);
      if(lat===null||lon===null) return null;
      const hdop=parseFloat(f[8]);
      return {lat,lon,acc:isFinite(hdop)?Math.max(3,hdop*5):5,t:Date.now()};
    },

    // NMEA ddmm.mmmm → decimal degrees
    _nd(raw,dir){
      if(!raw||!dir) return null;
      const dot=raw.indexOf('.');
      if(dot<2) return null;
      const deg=parseFloat(raw.slice(0,dot-2));
      const min=parseFloat(raw.slice(dot-2));
      if(!isFinite(deg)||!isFinite(min)) return null;
      const dd=deg+min/60;
      return (dir==='S'||dir==='W') ? -dd : dd;
    }
  };
  global.BleGPS = BleGPS;
})(window);
