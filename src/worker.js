onmessage = function (evt) {
  const workerData = evt.data;

  console.log("worker got message", workerData);
  switch (workerData.action) {
    case "fill":
      fillAction(workerData, this);
      break;
    case "process":
      processImageAction(workerData, this);
      break;
    default:
      console.error("Unknown action in paint worker", workerData);
  }
};

// A new image for colouring has been loaded, so cache it and
// pre-process it for quicker fills later.
// We go through it pixel by pixel, and find most of the areas that
// can be coloured in.  Each of these is identified, it's size and
// pixels stored, then in the end it is all sent back to the main thread
function processImageAction(workerData, self) {
  const dimensions = workerData.dimensions;
  const buffer = workerData.buffer;
  const { height, width } = dimensions;

  const bufferArray = new Uint8ClampedArray(buffer);

  // This array contains the pixels for the full image.
  // We use this to keep track of which pixels we have already filled in and which we have
  // not, so as to avoid extra work.
  let intermediateBuffer = new Array(height * width * 4);
  for (let i = 0; i < intermediateBuffer.length; i++) {
    intermediateBuffer[i] = 0;
  }

  let currentX = 0,
    currentY = 0;

  const pixelInfoToPost = [];

  function processNextPixel() {
    // Because we are using the Alpha pixel value to tell the UI thread
    // which of the multiple data buffers to use, we can only support
    // 254 of them (the number 0 means don't fast fill)
    if (pixelInfoToPost.length < 254) {
      let initX = currentX;

      for (let y = currentY; y < height; y += 20) {
        for (let x = initX; x < width; x += 20) {
          // Reset the initial X position so that we don't skip
          // most of the image when the next Y loop starts
          initX = 0;

          const firstIdx = getColorIndexForCoord(x, y, width);
          const alphaValue = intermediateBuffer[firstIdx + 3];
          const sourceAlphaValue = bufferArray[firstIdx + 3];

          // If the pixel is still transparent, we have found a pixel that could be
          // filled by the user, but which has not yet been processed by this function
          if (alphaValue === 0 && sourceAlphaValue === 0) {
            currentX = x;
            currentY = y;

            const alphaValueToSet = pixelInfoToPost.length + 1;

            fillImage(
              dimensions,
              `rgba(0,0,0,${alphaValueToSet})`,
              x,
              y,
              buffer,
              false,
              null,
              (fillBuffer, _processedPointsCount, fillDimensions) => {
                const { minX, maxX, maxY, minY } = fillDimensions;
                const fillWidth = maxX - minX + 1;
                const fillHeight = maxY - minY + 1;
                const fillBufferArray = new Uint8ClampedArray(fillBuffer);

                // if (fillHeight > 50 && fillWidth > 50) {
                // Only bother to cache the pixels if it is a reasonably large
                // area. Otherwise it'll fill up faster than the user can see anyway
                // }

                const partialBuffer = [];

                // Copy over the RGBA values to the intermediateBuffer
                for (let fillY = minY; fillY <= maxY; fillY++) {
                  // It's necessary to process the pixels in this order,
                  // row by row rather than column by column, as that is how
                  // the ImageData array is interpreted
                  for (let fillX = minX; fillX <= maxX; fillX++) {
                    const fillFirstIndex = getColorIndexForCoord(
                      fillX,
                      fillY,
                      dimensions.width
                    );
                    const fillA = fillBufferArray[fillFirstIndex + 3];

                    const red = fillBufferArray[fillFirstIndex];
                    const green = fillBufferArray[fillFirstIndex + 1];
                    const blue = fillBufferArray[fillFirstIndex + 2];

                    partialBuffer.push(0);
                    partialBuffer.push(0);
                    partialBuffer.push(0);

                    if (alphaValueToSet === fillA) {
                      intermediateBuffer[fillFirstIndex] = red;
                      intermediateBuffer[fillFirstIndex + 1] = green;
                      intermediateBuffer[fillFirstIndex + 2] = blue;
                      intermediateBuffer[fillFirstIndex + 3] = fillA;

                      // Store the non-transparent pixel in the subset of the canvas
                      // so that, when a fill action is triggered, this pixel will
                      // be coloured in
                      partialBuffer.push(255);
                    } else {
                      // Store a transparent pixel, so when a fill action is taken, this
                      // pixel will not be coloured in
                      partialBuffer.push(0);
                    }
                  }
                }

                pixelInfoToPost.push({
                  pixels: partialBuffer,
                  x: minX,
                  y: minY,
                  height: fillHeight,
                  width: fillWidth,
                });

                setTimeout(processNextPixel, 0);
              },
              alphaValueToSet
            );
            return;
          }
        }
      }
    }

    // Here we've made it through the entire canvas, so send all the pixel information back to the
    // UI thread.
    self.postMessage(
      {
        response: "process",
        height,
        width,
        allPixels: intermediateBuffer,
        pixelMaskInfo: pixelInfoToPost,
      },
      [buffer]
    );
    return;
  }

  processNextPixel();
}

function fillAction(workerData, self) {
  const { colour, dimensions, imageData, x, y } = workerData;
  const { height, width } = dimensions;

  fillImage(
    dimensions,
    colour,
    x,
    y,
    imageData,
    (buffer) => {
      console.log("fill progressing");
      // progress
      self.postMessage(
        {
          response: "fill",
          colour,
          isFinal: false,
          height,
          width,
          pixels: buffer,
        },
        [buffer]
      );
      return true;
    },
    (buffer, processedPointsCount) => {
      console.log("fill is complete");
      // complete
      self.postMessage(
        {
          response: "fill",
          colour,
          isFinal: true,
          height,
          width,
          pixels: processedPointsCount > 0 ? buffer : null,
        },
        [buffer]
      );
    }
  );
}

function fillImage(
  dimensions,
  colour,
  x,
  y,
  imageBuffer,
  onProgress,
  onComplete,
  forceSetAlphaValue
) {
  // https://gist.github.com/krhoyt/2c3514f20a05e4916a1caade0782953f
  let destImageData = new ImageData(dimensions.width, dimensions.height);
  let destData = destImageData.data;

  const srcImageData = new Uint8ClampedArray(imageBuffer);

  let point = null;
  const { width, height } = dimensions;

  // Use a custom stack that preallocates the entire possible
  // required array size in memory, and then manages the push() and
  // shift() calls so that no large array operations are required.
  const candidatePoints = createStaticStack(
    dimensions.width * dimensions.height
  );
  candidatePoints.push({ x, y });

  let [r, g, b] = colourStringToRgb(colour);

  const visited = {};
  const added = {};

  let processedPointsCount = 0;

  function addCandidate(xCoord, yCoord) {
    if (xCoord < 0 || xCoord > width - 1 || yCoord < 0 || yCoord > height - 1) {
      return;
    }
    const key = xCoord + "," + yCoord;
    if (!added[key] && !visited[key]) {
      candidatePoints.push({
        x: xCoord,
        y: yCoord,
      });
      added[key] = true;
    }
  }

  function getPointIdx(x, y) {
    return y * (width * 4) + x * 4;
  }

  const whiteSum = 255 * 3;
  function isWhite(startIdx) {
    const sum =
      srcImageData[startIdx] +
      srcImageData[startIdx + 1] +
      srcImageData[startIdx + 2];

    // Either it's black with full transparency (the default background)
    // or it's white drawn by the user
    return (sum === 0 && srcImageData[startIdx + 3] === 0) || sum === whiteSum;
  }

  // If the user is sketching, we can't depend on the fillable area
  // always having a low alpha value.  When they do a fill, it modifies
  // srcImageData for the next fill action to be that colour. So, in this
  // case we only fill where we have a matching colour to wherever they clicked.
  let selectedColourToMatch = null;
  let selectedColourIsWhite = false;

  const selPointIdx = getPointIdx(x, y);
  selectedColourIsWhite = isWhite(selPointIdx);

  let minX = x,
    maxX = x,
    minY = y,
    maxY = y;

  while ((point = candidatePoints.shift())) {
    const visitedKey = `${point.x},${point.y}`;

    if (!visited[visitedKey]) {
      const pointIdx = getPointIdx(point.x, point.y);

      const alphaIdx = pointIdx + 3;
      visited[visitedKey] = true;
      delete added[visitedKey];

      if (srcImageData.length < alphaIdx) {
        continue;
      }

      const currentPointIsWhite = isWhite(pointIdx);
      let canFill = srcImageData[alphaIdx] < 255 || currentPointIsWhite;

      // There can be semi-transparent pixels right next to fully opaque pixels.
      // Fill these in, but do not let the pixels next to them be filled, unless those
      // pixels are also touched by fully transparent pixels.
      // This fixes an issue where a seemingly opaque line lets the fill algorithm
      // to pass through it.
      let canPropagateFromPoint = srcImageData[alphaIdx] < 100;

      // If the user is sketching, we use this method, as we cannot rely on the background
      // being transparent
      if (selectedColourToMatch) {
        const bothAreWhite = selectedColourIsWhite && currentPointIsWhite;

        canPropagateFromPoint =
          bothAreWhite ||
          Math.abs(srcImageData[alphaIdx] - selectedColourToMatch[3]) < 100;

        let alphasAreEqual =
          srcImageData[pointIdx + 3] === selectedColourToMatch[3];

        if (
          bothAreWhite ||
          (!alphasAreEqual &&
            selectedColourToMatch[3] < 255 &&
            srcImageData[pointIdx + 3] < 255)
        ) {
          alphasAreEqual = true;
        }

        canFill =
          bothAreWhite ||
          (srcImageData[pointIdx] === selectedColourToMatch[0] &&
            srcImageData[pointIdx + 1] === selectedColourToMatch[1] &&
            srcImageData[pointIdx + 2] === selectedColourToMatch[2] &&
            alphasAreEqual);
      }

      if (canFill) {
        minX = Math.min(point.x, minX);
        minY = Math.min(point.y, minY);
        maxX = Math.max(point.x, maxX);
        maxY = Math.max(point.y, maxY);

        if (canPropagateFromPoint) {
          addCandidate(point.x, point.y - 1);
          addCandidate(point.x, point.y + 1);
          addCandidate(point.x - 1, point.y);
          addCandidate(point.x + 1, point.y);
        }

        destData[pointIdx] = r;
        destData[pointIdx + 1] = g;
        destData[pointIdx + 2] = b;
        destData[alphaIdx] = forceSetAlphaValue ? forceSetAlphaValue : 255;

        processedPointsCount++;

        if (onProgress && processedPointsCount % 5000 === 0) {
          // Send intermediate data if we're processing a large area,
          // so that the user knows that something is happening
          if (onProgress(destData.buffer)) {
            destImageData = new ImageData(dimensions.width, dimensions.height);
            destData = destImageData.data;
          }
        }
      }
    }
  }

  if (onComplete) {
    onComplete(destData.buffer, processedPointsCount, {
      minX,
      minY,
      maxX,
      maxY,
    });
  }
}

// A very simple stack structure, that preallocates an array size and only
// supports push and shift operations
function createStaticStack(size) {
  const arr = new Array(size);
  let shiftNextIdx = 0;
  let pushNextIdx = 0;

  return {
    push: (item) => {
      if (pushNextIdx >= arr.length) {
        arr.push(item);
        pushNextIdx = arr.length;
      } else {
        arr[pushNextIdx] = item;
        pushNextIdx++;
      }
    },
    shift: () => {
      if (shiftNextIdx < pushNextIdx) {
        const item = arr[shiftNextIdx];
        shiftNextIdx++;
        return item;
      }
      return null;
    },
  };
}

function colourStringToRgb(colour) {
  if (colour.indexOf("rgba(") === 0) {
    return colour
      .slice(5)
      .split(")")[0]
      .split(",")
      .map((numStr) => {
        return strToNum(numStr.trim());
      })
      .slice(0, 3);
  } else if (colour.indexOf("rgb(") === 0) {
    return colour
      .slice(4)
      .split(")")[0]
      .split(",")
      .map((numStr) => {
        return strToNum(numStr.trim());
      })
      .slice(0, 3);
  } else if (colour.indexOf("#") === 0) {
    return hexToRgb(colour);
  }
  return null;
}

function hexToRgb(hex) {
  const normal = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (normal) {
    return normal.slice(1).map((e) => parseInt(e, 16));
  }

  const shorthand = hex.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shorthand) {
    return shorthand.slice(1).map((e) => 0x11 * parseInt(e, 16));
  }

  return null;
}

function strToNum(str) {
  if (str === null || str === undefined) {
    return str;
  }
  let strVal = str;
  if (Array.isArray(str)) {
    strVal = str[0];
  }
  if (typeof strVal === "string") {
    if (strVal.trim().length === 0) {
      return 0;
    }
    return parseFloat(strVal);
  }
  return strVal;
}

// https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Pixel_manipulation_with_canvas
function getColorIndexForCoord(x, y, width) {
  return y * (width * 4) + x * 4;
}
