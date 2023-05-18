(function () {
  const IMAGE_PATH = "./images/airplane.png";

  function runExample() {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");

    let colour = "#ff0000";

    // Load the image into the canvas
    const img = new Image();
    let initialImageData = null;

    img.onload = () => {
      context.drawImage(img, 0, 0);
      initialImageData = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      );
    };
    img.src = IMAGE_PATH;

    canvas.addEventListener("click", (evt) => {
      const { x, y } = getEventCoords(evt, canvas.getBoundingClientRect());

      const dimensions = { height: canvas.height, width: canvas.width };

      console.log("x", x, "y", y);
      worker.postMessage(
        {
          action: "fill",
          dimensions,
          imageData: initialImageData.data.buffer,
          x,
          y,
          colour,
        },
        [initialImageData.data.buffer]
      );
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

  window.addEventListener("load", runExample);
})();
