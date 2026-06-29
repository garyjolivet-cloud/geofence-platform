import Toybox.Ble;
import Toybox.Lang;

class GpsBleDelegate extends Ble.BleDelegate {

    private var mView as GpsBridgeView;

    function initialize(view as GpsBridgeView) {
        BleDelegate.initialize();
        mView = view;
    }

    // Called when a central connects or disconnects
    function onConnectedStateChanged(device as Ble.Device,
                                     state  as Ble.ConnectionState) as Void {
        if (state == Ble.CONNECTION_STATE_CONNECTED) {
            mView.onCentralConnected();
        } else {
            mView.onCentralDisconnected();
        }
    }

    // Called when the central writes to a descriptor (e.g. enables notifications on TX)
    function onDescriptorWrite(descriptor as Ble.Descriptor,
                               status     as Number) as Void {
        if (status == Ble.STATUS_SUCCESS) {
            // Central subscribed — start streaming
            mView.onCentralSubscribed();
        }
    }

    // Called when the central writes a value to the RX characteristic (optional: commands)
    function onCharacteristicWrite(char   as Ble.LocalCharacteristic,
                                   status as Number) as Void {
        // Reserved for future command support from the phone app.
    }
}
