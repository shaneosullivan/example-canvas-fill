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
      const sourceImageData = getSrcImageData();
      worker.postMessage(
        {
          action: "process",
          dimensions,
          buffer: sourceImageData.data.buffer,
        },
        [sourceImageData.data.buffer]
      );
    };
    img.src = IMAGE_PATH;

    function getSrcImageData() {
      return unchangingContext.getImageData(0, 0, canvas.width, canvas.height);
    }

    // Listen to a click on the canvas, and try to fill in the selected
    // colour based on the x,y coordinates chosen.
    canvas.addEventListener("click", (evt) => {
      const { x, y } = getEventCoords(evt, canvas.getBoundingClientRect());

      console.log("User clicked the point x", x, "y", y);
      fillColour(x, y, selectedColour, context, unchangingContext, worker);
    });

    // Set up the worker
    const workerUrl = "./src/worker.js";
    let worker = new Worker(workerUrl);

    // The worker script communicates with this main thread script by passing
    // "message" events to the Worker object.  We can listen to those messages
    // like this.
    worker.addEventListener("message", (evt) => {
      const { data } = evt;

      console.log("Main thread got worker data", data);

      switch (data.response) {
        case "fill":
          // The worker has filled in some pixels, either all the
          // possible pixels, or a partial set of pixels as it works
          // its way through the search/fill algorithm.
          handleFillMessageFromWorker(data, context);
          break;
        case "process":
          // The worker has finished pre-processing the image, and
          // sent back a version of the image where each pixel is
          // assigned an alpha value from 1 to 255. These alpha values
          // are used to determine what discrete fillable area any given
          // pixel is in. This means that this algorithm can support up to
          // 255 individual discrete fillable spaces.  If a space is not
          // included in these, and therefore has an alpha of 0, we
          // fall back to using the slow method of filling.
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

  // We got data back from the Worker with the pixel data for the
  // full image.  Each pixel has an alpha value of between 0 and 255.
  // If the value is not 0, then that pixel is part of a space that
  // can be instantly filled.
  // The pixelMaskInfo is an array where each item looks like
  // {
  //   dataUrl?: string,
  //   pixels?: Array<number>,
  //   x: number,      // The leftmost pixel
  //   y: number,      // The topmost pixel
  //   height: number, // The height of the bounding box
  //   width: number,  // The width of the bounding box
  // }
  //
  // When the user clicks an (x,y) coordinate and is doing an
  // instant fill, we check the alpha value of that pixel and use
  // that integer to key into the pixelMaskInfo to select the
  // the "pixels" to fill.
  function handleProcessMessageFromWorker(data) {
    const { height, width, allPixels: pixels } = data;
    const pixelMaskInfo = data.pixelMaskInfo;

    if (width !== canvas.width || height != canvas.height) {
      // Outdated data, the screen has changed size, so
      // ignore it
      return;
    }

    const { canvas: tempCanvas, context: tempContext } = makeCanvas({
      height,
      width,
    });

    const imageData = new ImageData(width, height);
    imageData.data.set(new Uint8ClampedArray(pixels));

    tempContext.putImageData(imageData, 0, 0);

    // Store the mask info for use when the user clicks a pixel
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

  function fillColour(x, y, colour, context, sourceContext, worker) {
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
    // image data we got from the worker's pre-processing.
    // If it has a non zero alpha value, instead of using the worker to perform
    // a slow algorithmic fill, simply draw a rectangle filled with the right colour
    // over the entire cached image data and draw that onto the
    // main canvasNode.  This works to only draw the right pixels and not
    // a full rectangle because we use the `globalCompositeOperation = "source-in"`
    // on the canvas pixelMaskContext
    if (maskInfo && enableFastFill) {
      const firstIdx = getColorIndexForCoord(x, y, maskInfo.node.width);
      const alphaValue = maskInfo.data.data[firstIdx + 3];

      if (alphaValue > 0) {
        // Yay, we can use the fast approach

        // The alpha value in the maskInfo is an index into the pixelMaskInfo array.
        // We subtract 1 from it as the number 0 tells us to NOT fill the pixel
        const pixelMaskInfo = maskInfo.pixelMaskInfo[alphaValue - 1];

        let maskDataUrl = pixelMaskInfo.dataUrl;

        const { canvas: pixelMaskCanvasNode, context: pixelMaskContext } =
          makeCanvas({
            height: pixelMaskInfo.height,
            width: pixelMaskInfo.width,
          });

        function performDraw() {
          // Here's the canvas magic that makes it just draw the non
          // transparent pixels onto our main canvas
          pixelMaskContext.globalCompositeOperation = "source-in";

          pixelMaskContext.fillStyle = colour;

          pixelMaskContext.fillRect(
            0,
            0,
            pixelMaskInfo.width,
            pixelMaskInfo.height
          );

          context.drawImage(
            pixelMaskCanvasNode,
            pixelMaskInfo.x,
            pixelMaskInfo.y
          );
        }

        if (!maskDataUrl) {
          // Offscreen canvas is not available, so use the array of pixels
          // to call putImageData on the canvas.  This is a slower operation,
          // which is why when OffscreenCanvas is supported by the browser
          // we want to use that instead. It turns out that setting a data URI
          // source on an Image is about 10x faster than calling
          // putImageData on a Canvas.

          const pixelMaskImageData = new ImageData(
            pixelMaskInfo.width,
            pixelMaskInfo.height
          );

          pixelMaskImageData.data.set(
            new Uint8ClampedArray(pixelMaskInfo.pixels)
          );
          pixelMaskContext.putImageData(pixelMaskImageData, 0, 0);

          performDraw();
        } else {
          // OffscreenCanvas is available, so we have a dataUri to set as the
          // src of a simple Image.  This is 10x faster than calling
          // putImageData on the Canvas context.
          const img = new Image();
          img.onload = () => {
            pixelMaskContext.drawImage(img, 0, 0);
            performDraw();
          };
          img.src = maskDataUrl;
        }

        return;
      }
    }

    const dimensions = {
      height: canvas.height,
      width: canvas.width,
    };

    // You have to get these image data objects new every time, because
    // passing through their data buffers to a Worker causes the buffers
    // to be fully read then drained and unusable again.
    const currentImageData = contextForData.getImageData(
      0,
      0,
      dimensions.width,
      dimensions.height
    );

    const sourceImageData = sourceContext.getImageData(
      0,
      0,
      dimensions.width,
      dimensions.height
    );

    // Delegate the work of filling the image to the web worker.
    // This puts it on another thread so large fills don't block the UI thread.
    worker.postMessage(
      {
        action: "fill",
        dimensions,
        sourceImageData: sourceImageData.data.buffer,
        currentImageData: currentImageData.data.buffer,
        x,
        y,
        colour,
      },
      [currentImageData.data.buffer]
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

  // https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Pixel_manipulation_with_canvas
  function getColorIndexForCoord(x, y, width) {
    return y * (width * 4) + x * 4;
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
