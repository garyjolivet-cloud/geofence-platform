import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

class GpsBridgeApp extends Application.AppBase {

    private var mView as GpsBridgeView?;

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() as Array<Views or InputDelegates> {
        mView = new GpsBridgeView();
        return [mView, new GpsBridgeInputDelegate()] as Array<Views or InputDelegates>;
    }

    function onStop(state as Dictionary?) as Void {
        if (mView != null) {
            (mView as GpsBridgeView).cleanup();
        }
    }
}
