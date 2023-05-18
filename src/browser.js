(function () {
  const IMAGE_PATH = "./images/airplane.png";
  let fillSpeed = "slow";
  let selectedColour = "#FF0000";
  let maskInfo = null;

  function runExample() {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");

    addFormListener();

    const { context: unchangingContext } = makeCanvas({
      height: canvas.height,
      width: canvas.width,
    });

    // Load the image into the canvas
    const img = new Image();

    img.onload = () => {
      context.drawImage(img, 0, 0);
      unchangingContext.drawImage(img, 0, 0);

      const dimensions = { height: canvas.height, width: canvas.width };
      const imageData = getSrcImageData();
      worker.postMessage(
        {
          action: "process",
          dimensions,
          buffer: imageData.data.buffer,
        },
        [imageData.data.buffer]
      );
    };
    img.src = IMAGE_PATH;

    function getSrcImageData() {
      return unchangingContext.getImageData(0, 0, canvas.width, canvas.height);
    }

    canvas.addEventListener("click", (evt) => {
      const { x, y } = getEventCoords(evt, canvas.getBoundingClientRect());

      console.log("x", x, "y", y);
      fillColour(x, y, colour, context);
    });

    // Set up the worker
    const workerUrl = "./src/worker.js";
    let worker = new Worker(workerUrl);

    worker.addEventListener("message", (evt) => {
      const { data } = evt;

      console.log("Main thread got worker data", data);

      switch (data.response) {
        case "fill":
          handleFillMessageFromWorker(data, context);
          break;
        case "process":
          handleProcessMessageFromWorker(data);
          break;
        default:
          console.error("Unknown response from worker", data);
      }
    });
  }

  function handleFillMessageFromWorker(data, context) {
    const { height, width, pixels } = data;

    if (!pixels) {
      // No change was made
      return;
    }
    const imageData = new ImageData(width, height);
    imageData.data.set(new Uint8ClampedArray(pixels));

    const { canvas: tempCanvas, context: tempContext } = makeCanvas({
      height,
      width,
    });
    tempContext.putImageData(imageData, 0, 0);

    // Draw the full image
    context.drawImage(tempCanvas, 0, 0);
  }

  // We got data back from the Worker with the outside of the colouring
  // image made opaque, but everything else made transparent.
  // We will use this for when the user uses the 'fill' action on
  // any pixel that is part of the background of the image
  function handleProcessMessageFromWorker(data) {
    const { height, width, allPixels: pixels } = data;
    const pixelMaskInfo = data.pixelMaskInfo;

    if (width !== canvas.width || height != canvas.height) {
      // Outdated data, the screen has changed size, so
      // ignore it
      return;
    }

    const { canvas: tempCanvas, context: tempContext } = makeCanvas(
      {
        height,
        width,
      },
      true
    );

    // set all to transparent black
    tempContext.clearRect(0, 0, width, height);

    const imageData = new ImageData(width, height);
    imageData.data.set(new Uint8ClampedArray(pixels));

    const { canvas: tempCanvas2, context: tempContext2 } = makeCanvas({
      height,
      width,
    });
    tempContext2.putImageData(imageData, 0, 0);

    // Now we have just the data from the worker as the only
    // non-transparent pixels in the image
    tempContext.drawImage(tempCanvas2, 0, 0);

    maskInfo = {
      node: tempCanvas,
      data: tempContext.getImageData(0, 0, width, height),
      pixelMaskInfo,
    };

    // https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Compositing#globalcompositeoperation
    // This is the magic incantation that gets all this canvas sorcery to work!!
    // It makes it so that the fillRect() call later only fills in the non-transparent
    // pixels and leaves the others transparent.  This way, only the background of the image is
    // coloured in and the main subject is left as an empty 'mask' in this canvas.
    // We can then easily use drawImage to place that masked image on top of the
    // canvas the user is drawing
    tempContext.globalCompositeOperation = "source-in";
  }

  function fillColour(x, y, colour, context) {
    // Fill all the transparent pixels in the source image that is being
    // coloured in

    let contextForData = context;

    // Only allow the background to be filled quickly if
    // the user is colouring in a preselected image, as this
    // will not change. If they are sketching, then
    // the image is always changing and we cannot take the
    // shortcut
    const enableFastFill = fillSpeed === "instant";

    x = Math.floor(x);
    y = Math.floor(y);

    // First check if this pixel is non-transparent in our cached
    // image data. If so, instead of using the worker to perform
    // an algorithmic fill, simply draw a rectangle with the right colour
    // over the entire cached image data and draw that onto the
    // main canvasNode.
    if (maskInfo && enableFastFill) {
      const firstIdx = getColorIndexForCoord(x, y, maskInfo.node.width);
      const alphaValue = maskInfo.data.data[firstIdx + 3];

      if (alphaValue > 0) {
        // Yay, we can use the fast approach

        // The alpha value in the maskInfo is an index into the pixelMaskInfo array.
        // We subtract 1 from it as the number 0 tells us to NOT fill the pixel
        const pixelMaskInfo = maskInfo.pixelMaskInfo[alphaValue - 1];
        const { canvas: pixelMaskCanvasNode, context: pixelMaskContext } =
          makeCanvas({
            height: pixelMaskInfo.height,
            width: pixelMaskInfo.width,
          });

        const pixelMaskImageData = new ImageData(
          pixelMaskInfo.width,
          pixelMaskInfo.height
        );
        pixelMaskImageData.data.set(
          new Uint8ClampedArray(pixelMaskInfo.pixels)
        );
        pixelMaskContext.putImageData(pixelMaskImageData, 0, 0);

        pixelMaskContext.globalCompositeOperation = "source-in";

        pixelMaskContext.fillStyle = colour;

        pixelMaskContext.fillRect(
          0,
          0,
          pixelMaskInfo.width,
          pixelMaskInfo.height
        );

        userContext.drawImage(
          pixelMaskCanvasNode,
          pixelMaskInfo.x,
          pixelMaskInfo.y
        );

        storeUndoPoint();
        callOnChange();

        return;
      }
    }

    // if a fill takes more than 10 seconds, theres likely a bug
    // so let the user do another
    const limit = Date.now() - 1000 * 10;
    ongoingFills = ongoingFills.filter((time) => time > limit);
    if (ongoingFills.length > 2) {
      // If too many fills are queued, ignore this as it can crash
      // the browser

      return;
    }

    ongoingFills.push(Date.now());

    const dimensions = {
      height: imgCanvasNode.height,
      width: imgCanvasNode.width,
    };

    const imageData = contextForData.getImageData(
      0,
      0,
      dimensions.width,
      dimensions.height
    );

    // Delegate the work of filling the image to the web worker.
    // This puts it on another thread so large fills don't block the UI thread.
    paintWorker.postMessage(
      {
        action: WorkerAction.FILL,
        dimensions,
        foreground: imageData.data.buffer,
        isSketchFill: contextForData === userContext,
        x,
        y,
        colour,
      },
      [imageData.data.buffer]
    );
  }

  function makeCanvas(size) {
    const tempCanvas = document.createElement("canvas");
    if (size) {
      tempCanvas.width = size.width;
      tempCanvas.height = size.height;
    }
    const tempContext = tempCanvas.getContext("2d");

    return { canvas: tempCanvas, context: tempContext };
  }

  function getEventCoords(evt, nodeRect) {
    let x, y;
    if (evt.touches && evt.touches.length > 0) {
      x = evt.touches[0].clientX;
      y = evt.touches[0].clientY;
    } else {
      x = evt.clientX;
      y = evt.clientY;
    }
    return { x: Math.round(x - nodeRect.x), y: Math.round(y - nodeRect.y) };
  }

  function addFormListener() {
    document.getElementById("speedForm").addEventListener("change", (evt) => {
      fillSpeed = evt.target.value;
    });
    document.getElementById("colourForm").addEventListener("change", (evt) => {
      selectedColour = evt.target.value;
    });
  }

  window.addEventListener("load", runExample);
})();
