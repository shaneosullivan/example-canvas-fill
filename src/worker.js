onmessage = function (evt) {
  const workerData = evt.data;

  console.log("worker got message", workerData);
  switch (workerData.action) {
    case "fill":
      fillAction(workerData, this);
      break;
    default:
      console.error("Unknown action in paint worker", workerData);
  }
};

function fillAction(workerData, self) {
  const { colour, dimensions, foreground, token, x, y } = workerData;
  const { height, width } = dimensions;

  fillImage(
    dimensions,
    colour,
    x,
    y,
    foreground,
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
          token,
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

  const foregroundData = new Uint8ClampedArray(imageBuffer);

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
      foregroundData[startIdx] +
      foregroundData[startIdx + 1] +
      foregroundData[startIdx + 2];

    // Either it's black with full transparency (the default background)
    // or it's white drawn by the user
    return (
      (sum === 0 && foregroundData[startIdx + 3] === 0) || sum === whiteSum
    );
  }

  // If the user is sketching, we can't depend on the fillable area
  // always having a low alpha value.  When they do a fill, it modifies
  // foregroundData for the next fill action to be that colour. So, in this
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

      if (foregroundData.length < alphaIdx) {
        continue;
      }

      const currentPointIsWhite = isWhite(pointIdx);
      let canFill = foregroundData[alphaIdx] < 255 || currentPointIsWhite;

      // There can be semi-transparent pixels right next to fully opaque pixels.
      // Fill these in, but do not let the pixels next to them be filled, unless those
      // pixels are also touched by fully transparent pixels.
      // This fixes an issue where a seemingly opaque line lets the fill algorithm
      // to pass through it.
      let canPropagateFromPoint = foregroundData[alphaIdx] < 100;

      // If the user is sketching, we use this method, as we cannot rely on the background
      // being transparent
      if (selectedColourToMatch) {
        const bothAreWhite = selectedColourIsWhite && currentPointIsWhite;

        canPropagateFromPoint =
          bothAreWhite ||
          Math.abs(foregroundData[alphaIdx] - selectedColourToMatch[3]) < 100;

        let alphasAreEqual =
          foregroundData[pointIdx + 3] === selectedColourToMatch[3];

        if (
          bothAreWhite ||
          (!alphasAreEqual &&
            selectedColourToMatch[3] < 255 &&
            foregroundData[pointIdx + 3] < 255)
        ) {
          alphasAreEqual = true;
        }

        canFill =
          bothAreWhite ||
          (foregroundData[pointIdx] === selectedColourToMatch[0] &&
            foregroundData[pointIdx + 1] === selectedColourToMatch[1] &&
            foregroundData[pointIdx + 2] === selectedColourToMatch[2] &&
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
