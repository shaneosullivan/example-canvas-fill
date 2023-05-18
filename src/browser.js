(function () {
  const IMAGE_PATH = "./images/airplane.png";

  function runExample() {
    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("2d");

    // Load the image into the canvas
    const img = new Image();

    img.onload = () => {
      context.drawImage(img, 0, 0);
    };
    img.src = IMAGE_PATH;

    canvas.addEventListener("click", (evt) => {
      const { x, y } = getEventCoords(evt, canvas.getBoundingClientRect());

      console.log("x", x, "y", y);
    });

    // Set up the worker
    const workerUrl = "./src/worker.js";
    let worker = new Worker(workerUrl);

    worker.addEventListener("message", (evt) => {
      const { data } = evt;

      const { token } = data;

      if (token && token !== paintWorkerToken[data.response]) {
        // The work took too long, this response is no longer valid,
        // so ignore it
        return;
      }

      switch (data.response) {
        case "fill":
          handleFillMessageFromWorker(data);
          break;
        default:
          console.error("Unknown response from worker", data);
      }
    });
  }

  function handleFillMessageFromWorker(data) {
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
    userContext.drawImage(tempCanvas, 0, 0);
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
