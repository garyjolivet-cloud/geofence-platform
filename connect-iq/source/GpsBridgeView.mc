import Toybox.Ble;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.Position;
import Toybox.Sensor;
import Toybox.Timer;
import Toybox.WatchUi;

// Nordic UART Service UUIDs (128-bit, as byte arrays in BLE wire order = reversed string)
const NUS_SERVICE_UUID as Ble.Uuid = Ble.stringToUuid("6e400001-b5a3-f393-e0a9-e50e24dcca9e");
const NUS_TX_UUID      as Ble.Uuid = Ble.stringToUuid("6e400003-b5a3-f393-e0a9-e50e24dcca9e");
const NUS_RX_UUID      as Ble.Uuid = Ble.stringToUuid("6e400002-b5a3-f393-e0a9-e50e24dcca9e");

class GpsBridgeView extends WatchUi.View {

    // BLE
    private var mProfile    as Ble.LocalProfile?;
    private var mTxChar     as Ble.LocalCharacteristic?;
    private var mDelegate   as GpsBleDelegate?;
    private var mNotifying  as Boolean = false;   // true once central enables notify

    // GPS
    private var mLat        as Float?;
    private var mLon        as Float?;
    private var mAccM       as Float = 99.0;

    // Compass
    private var mHeadingDeg as Float?;            // null until first valid compass reading

    // UI
    private var mStatus     as String = "Starting…";
    private var mConnected  as Boolean = false;
    private var mTimer      as Timer.Timer?;
    private var mFixCount   as Number = 0;

    function initialize() {
        View.initialize();
    }

    function onLayout(dc as Graphics.Dc) as Void {
        // Drawn programmatically — no XML layout needed.
    }

    function onShow() as Void {
        _setupBle();
        _setupGps();
        _setupCompass();
        mTimer = new Timer.Timer();
        mTimer.start(method(:onTick), 1000, true);
    }

    function onHide() as Void {
        cleanup();
    }

    function cleanup() as Void {
        if (mTimer != null) { (mTimer as Timer.Timer).stop(); mTimer = null; }
        Position.enableLocationEvents(Position.LOCATION_DISABLE, method(:onPosition));
        try { Sensor.unregisterSensorDataListener(); } catch (e instanceof Exception) {}
    }

    // ── BLE peripheral setup ─────────────────────────────────────────
    private function _setupBle() as Void {
        try {
            var profile = {
                :uuid            => NUS_SERVICE_UUID,
                :characteristics => [
                    {
                        :uuid        => NUS_TX_UUID,
                        :properties  => Ble.PROPERTY_NOTIFY,
                        :descriptors => [{ :uuid => Ble.DESCRIPTOR_CLIENT_CHAR_CONFIG }]
                    },
                    {
                        :uuid        => NUS_RX_UUID,
                        :properties  => Ble.PROPERTY_WRITE | Ble.PROPERTY_WRITE_NO_RESPONSE,
                        :permissions => Ble.PERMISSION_WRITE
                    }
                ]
            };

            mDelegate = new GpsBleDelegate(self);
            Ble.setDelegate(mDelegate as Ble.BleDelegate);
            mProfile  = Ble.registerProfile(profile);

            // Cache the TX characteristic so onTick can write without searching every second
            if (mProfile != null) {
                var svc = (mProfile as Ble.LocalProfile).getService(NUS_SERVICE_UUID);
                if (svc != null) {
                    mTxChar = svc.getCharacteristic(NUS_TX_UUID);
                }
            }
            mStatus = "Waiting for phone…";
        } catch (e instanceof Ble.Exception) {
            mStatus = "BLE error";
        }
    }

    // ── GPS setup ────────────────────────────────────────────────────
    private function _setupGps() as Void {
        Position.enableLocationEvents(
            Position.LOCATION_CONTINUOUS,
            method(:onPosition)
        );
    }

    // ── Compass setup ────────────────────────────────────────────────
    private function _setupCompass() as Void {
        try {
            var options = {
                :period      => 1,
                :sensorTypes => [Sensor.SENSOR_HEADING]
            };
            Sensor.registerSensorDataListener(method(:onSensorData), options);
        } catch (e instanceof Exception) {
            // Compass unavailable on this hardware; GPS-only mode continues normally.
        }
    }

    // GPS callback — fires on every new fix
    function onPosition(info as Position.Info) as Void {
        if (info.accuracy == Position.QUALITY_NOT_AVAILABLE ||
            info.accuracy == Position.QUALITY_LAST_KNOWN) {
            return;
        }
        var deg = info.position.toDegrees();
        mLat  = deg[0].toFloat();
        mLon  = deg[1].toFloat();
        mAccM = _qualityToMetres(info.accuracy);
        mFixCount++;
    }

    // Compass sensor callback
    function onSensorData(sensorData as Sensor.SensorData) as Void {
        if ((sensorData has :heading) && sensorData.heading != null) {
            // CIQ returns heading in radians (0 = North, clockwise); convert to degrees
            var rad = sensorData.heading as Float;
            mHeadingDeg = ((rad * 180.0 / Math.PI) + 360.0) % 360.0;
        }
    }

    // 1 Hz timer — send GPS + compass string to subscribed central
    function onTick() as Void {
        if (mNotifying && mTxChar != null && mLat != null) {
            var line = (mLat as Float).format("%.6f") + "," +
                       (mLon as Float).format("%.6f") + "," +
                       mAccM.format("%.1f");

            // Append compass heading when available — engine parses as 4th field
            if (mHeadingDeg != null) {
                line = line + "," + (mHeadingDeg as Float).format("%.1f");
            }

            line = line + "\n";

            try {
                (mTxChar as Ble.LocalCharacteristic).setValue(line.toUtf8Array() as ByteArray);
                (mTxChar as Ble.LocalCharacteristic).notify();
            } catch (e instanceof Ble.Exception) {
                // Central disconnected mid-send; onConnectedStateChanged will clean up.
            }
        }
        WatchUi.requestUpdate();
    }

    // ── Draw ─────────────────────────────────────────────────────────
    function onUpdate(dc as Graphics.Dc) as Void {
        dc.setColor(Graphics.COLOR_BLACK, Graphics.COLOR_BLACK);
        dc.clear();

        var cx = dc.getWidth()  / 2;
        var cy = dc.getHeight() / 2;

        // Title
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 56, Graphics.FONT_SMALL,
                    "GPS Bridge", Graphics.TEXT_JUSTIFY_CENTER);

        // Status dot + text
        var dotColor = mConnected ? Graphics.COLOR_GREEN : Graphics.COLOR_LT_GRAY;
        dc.setColor(dotColor, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy - 28, Graphics.FONT_XTINY,
                    mStatus, Graphics.TEXT_JUSTIFY_CENTER);

        // GPS readout
        dc.setColor(Graphics.COLOR_WHITE, Graphics.COLOR_TRANSPARENT);
        if (mLat != null) {
            var posStr = (mLat as Float).format("%.4f") + ", " +
                         (mLon as Float).format("%.4f");
            dc.drawText(cx, cy - 4, Graphics.FONT_XTINY, posStr,
                        Graphics.TEXT_JUSTIFY_CENTER);
            dc.setColor(Graphics.COLOR_BLUE, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy + 16, Graphics.FONT_XTINY,
                        "±" + mAccM.format("%.0f") + " m  ·  " + mFixCount + " fixes",
                        Graphics.TEXT_JUSTIFY_CENTER);
        } else {
            dc.setColor(Graphics.COLOR_YELLOW, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy - 4, Graphics.FONT_XTINY,
                        "Acquiring GPS…", Graphics.TEXT_JUSTIFY_CENTER);
        }

        // Compass heading
        if (mHeadingDeg != null) {
            dc.setColor(Graphics.COLOR_GREEN, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy + 36, Graphics.FONT_XTINY,
                        "🧭 " + (mHeadingDeg as Float).format("%.0f") + "°",
                        Graphics.TEXT_JUSTIFY_CENTER);
        } else {
            dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
            dc.drawText(cx, cy + 36, Graphics.FONT_XTINY,
                        "compass: acquiring…", Graphics.TEXT_JUSTIFY_CENTER);
        }

        // Hint
        dc.setColor(Graphics.COLOR_DK_GRAY, Graphics.COLOR_TRANSPARENT);
        dc.drawText(cx, cy + 56, Graphics.FONT_XTINY,
                    "Back key to exit", Graphics.TEXT_JUSTIFY_CENTER);
    }

    // ── Called by GpsBleDelegate ──────────────────────────────────────
    function onCentralConnected() as Void {
        mConnected = true;
        mStatus    = "Phone connected";
        WatchUi.requestUpdate();
    }

    function onCentralSubscribed() as Void {
        mNotifying = true;
        mStatus    = "Streaming GPS";
        WatchUi.requestUpdate();
    }

    function onCentralDisconnected() as Void {
        mConnected = false;
        mNotifying = false;
        mStatus    = "Waiting for phone…";
        WatchUi.requestUpdate();
    }

    // ── Helpers ───────────────────────────────────────────────────────
    private function _qualityToMetres(q as Position.Quality) as Float {
        if      (q == Position.QUALITY_GOOD)   { return  4.0; }
        else if (q == Position.QUALITY_USABLE) { return 12.0; }
        else                                   { return 40.0; }
    }
}
