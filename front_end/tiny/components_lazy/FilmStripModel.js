/*
 * Copyright 2015 The Chromium Authors. All rights reserved.
 * Use of this source code is governed by a BSD-style license that can be
 * found in the LICENSE file.
 */

/**
 * @unrestricted
 */
Components.FilmStripModel = class {
  /**
   * @param {!SDK.TracingModel} tracingModel
   * @param {number=} zeroTime
   */
  constructor(tracingModel, zeroTime) {
    this.reset(tracingModel, zeroTime);
  }

  /**
   * @param {!SDK.TracingModel} tracingModel
   * @param {number=} zeroTime
   */
  reset(tracingModel, zeroTime) {
    this._zeroTime = zeroTime || tracingModel.minimumRecordTime();
    this._spanTime = tracingModel.maximumRecordTime() - this._zeroTime;

    /** @type {!Array<!Components.FilmStripModel.Frame>} */
    this._frames = [];
    var browserMain = SDK.TracingModel.browserMainThread(tracingModel);
    if (!browserMain)
      return;

    var events = browserMain.events();
    for (var i = 0; i < events.length; ++i) {
      var event = events[i];
      if (event.startTime < this._zeroTime)
        continue;
      if (!event.hasCategory(Components.FilmStripModel._category))
        continue;
      if (event.name === Components.FilmStripModel.TraceEvents.CaptureFrame) {
        var data = event.args['data'];
        if (data)
          this._frames.push(Components.FilmStripModel.Frame._fromEvent(this, event, this._frames.length));
      } else if (event.name === Components.FilmStripModel.TraceEvents.Screenshot) {
        this._frames.push(Components.FilmStripModel.Frame._fromSnapshot(
            this, /** @type {!SDK.TracingModel.ObjectSnapshot} */ (event), this._frames.length));
      }
    }
  }

  /**
   * @return {!Array<!Components.FilmStripModel.Frame>}
   */
  frames() {
    return this._frames;
  }

  /**
   * @return {number}
   */
  zeroTime() {
    return this._zeroTime;
  }

  /**
   * @return {number}
   */
  spanTime() {
    return this._spanTime;
  }

  /**
   * @param {number} timestamp
   * @return {?Components.FilmStripModel.Frame}
   */
  frameByTimestamp(timestamp) {
    var index = this._frames.upperBound(timestamp, (timestamp, frame) => timestamp - frame.timestamp) - 1;
    return index >= 0 ? this._frames[index] : null;
  }
};

Components.FilmStripModel._category = 'disabled-by-default-devtools.screenshot';

Components.FilmStripModel.TraceEvents = {
  CaptureFrame: 'CaptureFrame',
  Screenshot: 'Screenshot'
};

/**
 * @unrestricted
 */
Components.FilmStripModel.Frame = class {
  /**
   * @param {!Components.FilmStripModel} model
   * @param {number} timestamp
   * @param {number} index
   */
  constructor(model, timestamp, index) {
    this._model = model;
    this.timestamp = timestamp;
    this.index = index;
    /** @type {?string} */
    this._imageData = null;
    /** @type {?SDK.TracingModel.ObjectSnapshot} */
    this._snapshot = null;
  }

  /**
   * @param {!Components.FilmStripModel} model
   * @param {!SDK.TracingModel.Event} event
   * @param {number} index
   * @return {!Components.FilmStripModel.Frame}
   */
  static _fromEvent(model, event, index) {
    var frame = new Components.FilmStripModel.Frame(model, event.startTime, index);
    frame._imageData = event.args['data'];
    return frame;
  }

  /**
   * @param {!Components.FilmStripModel} model
   * @param {!SDK.TracingModel.ObjectSnapshot} snapshot
   * @param {number} index
   * @return {!Components.FilmStripModel.Frame}
   */
  static _fromSnapshot(model, snapshot, index) {
    var frame = new Components.FilmStripModel.Frame(model, snapshot.startTime, index);
    frame._snapshot = snapshot;
    return frame;
  }

  /**
   * @return {!Components.FilmStripModel}
   */
  model() {
    return this._model;
  }

  /**
   * @return {!Promise<?string>}
   */
  imageDataPromise() {
    if (this._imageData || !this._snapshot)
      return Promise.resolve(this._imageData);

    return /** @type {!Promise<?string>} */ (this._snapshot.objectPromise());
  }
};
