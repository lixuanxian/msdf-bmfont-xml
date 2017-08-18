const utils = require('./lib/utils');
const opentype = require('opentype.js');
const exec = require('child_process').exec;
const mapLimit = require('map-limit');
const MaxRectsPacker = require('maxrects-packer');
const Canvas = require('canvas-prebuilt');
const path = require('path');
const ProgressBar = require('cli-progress');
const fs = require('fs');

const defaultCharset = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~".split('');

const binaryLookup = {
  darwin: 'msdfgen.osx',
  win32: 'msdfgen.exe',
  linux: 'msdfgen.linux'
};

module.exports = generateBMFont;

/**
 * Creates a BMFont compatible bitmap font of signed distance fields from a font file
 *
 * @param {string} fontPath - Path to the input ttf font (otf and ttc not supported yet) 
 * @param {Object} opt - Options object for generating bitmap font (Optional) :
 *            outputType : font file format Avaliable: xml(default), json
 *            filename : filename of both font file and font textures
 *            fontSize : font size for generated textures (default 42)
 *            charset : charset in generated font, could be array or string (default is Western)
 *            textureWidth : Width of generated textures (default 512)
 *            textureHeight : Height of generated textures (default 512)
 *            distanceRange : distance range for computing signed distance field
 *            fieldType : "msdf"(default), "sdf", "psdf"
 *            roundDecimal  : rounded digits of the output font file. (Defaut is null)
 * @param {function(string, Array.<Object>, Object)} callback - Callback funtion(err, textures, font) 
 *
 */
function generateBMFont (fontPath, opt, callback) {
  const binName = binaryLookup[process.platform];
  if (binName === undefined) {
    throw new Error(`No msdfgen binary for platform ${process.platform}.`);
  }
  const binaryPath = path.join(__dirname, 'bin', binName);

  if (!fontPath || typeof fontPath !== 'string') {
    throw new TypeError('must specify a font path');
  }
  if (typeof opt === 'function') {
    callback = opt;
    opt = {};
  }
  if (callback && typeof callback !== 'function') {
    throw new TypeError('expected callback to be a function');
  }
  if (!callback) {
    throw new TypeError('missing callback');
  }

  callback = callback || function () {};
  opt = opt || {};
  const reuse = typeof opt.reuse === 'boolean' ? {} : opt.reuse.opt;
  let charset = opt.charset = (typeof opt.charset === 'string' ? opt.charset.split('') : opt.charset) || reuse.charset || defaultCharset;
  const outputType = opt.outputType = opt.outputType || reuse.outputType || "xml";
  let filename = opt.filename = opt.filename || reuse.filename;
  const fontSize = opt.fontSize = opt.fontSize || reuse.fontSize || 42;
  const fontSpacing = opt.fontSpacing = opt.fontSpacing || reuse.fontSpacing || [0, 0];
  const fontPadding = opt.fontPadding = opt.fontPadding || reuse.fontPadding || [0, 0, 0, 0];
  const textureWidth = opt.textureWidth = opt.textureSize[0] || reuse.textureSize[0] || 512;
  const textureHeight = opt.textureHeight = opt.textureSize[1] || reuse.textureSize[1] || 512;
  const texturePadding = opt.texturePadding = Number.isFinite(opt.texturePadding) ? opt.texturePadding : reuse.texturePadding || 1;
  const distanceRange = opt.distanceRang = opt.distanceRange || reuse.distanceRang || 4;
  const fieldType = opt.fieldType = opt.fieldType || reuse.fieldType || 'msdf';
  const roundDecimal = opt.roundDecimal = opt.roundDecimal || reuse.roundDecimal; // if no roudDecimal option, left null as-is
  const debug = opt.vector || false;
  const cfg = typeof opt.reuse === 'boolean' ? opt.reuse : false;

  // TODO: Validate options
  if (fieldType !== 'msdf' && fieldType !== 'sdf' && fieldType !== 'psdf') {
    throw new TypeError('fieldType must be one of msdf, sdf, or psdf');
  }

  const font = opentype.loadSync(fontPath);
  if (font.outlinesFormat !== 'truetype') {
    throw new TypeError('must specify a truetype font');
  }
  const canvas = new Canvas(textureWidth, textureHeight);
  const context = canvas.getContext('2d');
  const packer = new MaxRectsPacker(textureWidth, textureHeight, texturePadding);
  const chars = [];
  
  charset = charset.filter((e, i, self) => {
    return i == self.indexOf(e);
  }); // Remove duplicate

  // Initialize settings
  let settings = {};
  settings.opt = JSON.parse(JSON.stringify(opt));
  delete settings.opt['reuse']; // prune previous settings
  let pages = [];
  if (opt.reuse.packer !== undefined) {
    pages = opt.reuse.pages;
    packer.load(opt.reuse.packer.bins);
  }

  let bar;
  bar = new ProgressBar.Bar({
    format: "Genrating {percentage}%|{bar}| ({value}/{total}) {duration}s",
    clearOnComplete: true
  }, ProgressBar.Presets.shades_classic); 
  bar.start(charset.length, 0);

  mapLimit(charset, 15, (char, cb) => {
    generateImage({
      binaryPath,
      font,
      char,
      fontSize,
      fieldType,
      distanceRange,
      roundDecimal,
      debug
    }, (err, res) => {
      if (err) return cb(err);
      bar.increment();
      cb(null, res);
    });
  }, (err, results) => {
    if (err) callback(err);
    bar.stop();

    const os2 = font.tables.os2;
    const baseline = os2.sTypoAscender * (fontSize / font.unitsPerEm) + (distanceRange >> 1);
    const fontface = path.basename(fontPath, path.extname(fontPath));
    let fontDir = path.dirname(fontPath);
    if(!filename) {
      filename = path.join(fontDir, fontface); 
      console.log(`Use font-face as filename : ${filename}`);
    } else {
      if (path.dirname(filename).length > 0) fontDir = path.dirname(filename);
      filename = path.basename(filename, path.extname(filename));
    }

    packer.addArray(results);
    const textures = packer.bins.map((bin, index) => {
      let svg = "";
      let texname = "";
      if (index > pages.length - 1) { 
        texname = `${filename}.${index}`;
        pages.push(`${texname}.png`);
        if(fieldType === "msdf") {
          context.fillStyle = '#000000';
          context.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          context.clearRect(0, 0, canvas.width, canvas.height);
        }
      } else {
        texname = path.basename(pages[index], path.extname(pages[index]));
        let img = new Canvas.Image;
        img.src = fs.readFileSync(path.join(fontDir, `${texname}.png`));
        context.drawImage(img, 0, 0);
      }
      bin.rects.forEach(rect => {
        if (rect.data.imageData) {
          context.putImageData(rect.data.imageData, rect.x, rect.y);
          if (debug) {
            const x_woffset = rect.x - rect.data.fontData.xoffset + (distanceRange >> 1);
            const y_woffset = rect.y - rect.data.fontData.yoffset + baseline + (distanceRange >> 1);
            svg += font.charToGlyph(rect.data.fontData.char).getPath(x_woffset, y_woffset, fontSize).toSVG() + "\n";
          }
        }
        const charData = rect.data.fontData;
        charData.x = rect.x;
        charData.y = rect.y;
        charData.page = index;
        chars.push(rect.data.fontData);
      });
      let tex = {
        filename: path.join(fontDir, texname),
        texture: canvas.toBuffer()
      }
      if (debug) tex.svg = svg;
      return tex;
    });
    const kernings = [];
    charset.forEach(first => {
      charset.forEach(second => {
        const amount = font.getKerningValue(font.charToGlyph(first), font.charToGlyph(second));
        if (amount !== 0) {
          kernings.push({
            first: first.charCodeAt(0),
            second: second.charCodeAt(0),
            amount: amount * (fontSize / font.unitsPerEm)
          });
        }
      });
    });

    const fontData = {
      pages,
      chars,
      info: {
        face: fontface,
        type: fieldType,
        size: fontSize,
        bold: 0,
        italic: 0,
        charset,
        unicode: 1,
        stretchH: 100,
        smooth: 1,
        aa: 1,
        padding: fontPadding,
        spacing: fontSpacing
      },
      common: {
        lineHeight: (os2.sTypoAscender - os2.sTypoDescender + os2.sTypoLineGap) * (fontSize / font.unitsPerEm),
        base: baseline,
        scaleW: textureWidth,
        scaleH: textureHeight,
        pages: packer.bins.length,
        packed: 0,
        alphaChnl: 0,
        redChnl: 0,
        greenChnl: 0,
        blueChnl: 0
      },
      kernings: kernings
    };
    if(roundDecimal !== null) utils.roundAllValue(fontData, roundDecimal);
    let fontFile = {};
    const ext = outputType === "json" ? `.json` : `.fnt`;
    fontFile.filename = path.join(fontDir, fontface + ext);
    fontFile.data = utils.stringify(fontData, outputType);

    // Store pages name and available packer freeRects in settings
    settings.pages = pages;
    settings.packer = {};
    settings.packer.bins = packer.save(); 
    fontFile.settings = settings;

    console.log("\nGeneration complete!\n");
    callback(null, textures, fontFile);
  });
}

function generateImage (opt, callback) {
  const {binaryPath, font, char, fontSize, fieldType, distanceRange, roundDecimal, debug} = opt;
  const glyph = font.charToGlyph(char);
  const commands = glyph.getPath(0, 0, fontSize).commands;
  let contours = [];
  let currentContour = [];
  const bBox = glyph.getPath(0, 0, fontSize).getBoundingBox();
  commands.forEach(command => {
    if (command.type === 'M') { // new contour
      if (currentContour.length > 0) {
        contours.push(currentContour);
        currentContour = [];
      }
    }
    currentContour.push(command);
  });
  contours.push(currentContour);

  utils.setTolerance(0.2, 1);
  let numFiltered = utils.filterContours(contours);
  if (numFiltered && debug)
    console.log(`${char} removed ${numFiltered} small contour(s)`);
  // let numReversed = utils.alignClockwise(contours, false);
  // if (numReversed && debug)
  //   console.log(`${char} found ${numReversed}/${contours.length} reversed contour(s)`);
  let shapeDesc = utils.stringifyContours(contours);

  if (contours.some(cont => cont.length === 1)) console.log('length is 1, failed to normalize glyph');
  const scale = fontSize / font.unitsPerEm;
  const baseline = font.tables.os2.sTypoAscender * (fontSize / font.unitsPerEm);
  const pad = distanceRange >> 1;
  let width = Math.round(bBox.x2 - bBox.x1) + pad + pad;
  let height = Math.round(bBox.y2 - bBox.y1) + pad + pad;
  let xOffset = Math.round(-bBox.x1) + pad;
  let yOffset = Math.round(-bBox.y1) + pad;
  if (roundDecimal != null) {
    xOffset = utils.roundNumber(xOffset, roundDecimal);
    yOffset = utils.roundNumber(yOffset, roundDecimal);
  }
  let command = `${binaryPath} ${fieldType} -format text -stdout -size ${width} ${height} -translate ${xOffset} ${yOffset} -pxrange ${distanceRange} -defineshape "${shapeDesc}"`;

  exec(command, (err, stdout, stderr) => {
    if (err) return callback(err);
    const rawImageData = stdout.match(/([0-9a-fA-F]+)/g).map(str => parseInt(str, 16)); // split on every number, parse from hex
    const pixels = [];
    const channelCount = rawImageData.length / width / height;

    if (!isNaN(channelCount) && channelCount % 1 !== 0) {
      console.error(command);
      console.error(stdout);
      return callback(new RangeError('msdfgen returned an image with an invalid length'));
    }
    if (fieldType === 'msdf') {
      for (let i = 0; i < rawImageData.length; i += channelCount) {
        pixels.push(...rawImageData.slice(i, i + channelCount), 255); // add 255 as alpha every 3 elements
      }
    } else {
      for (let i = 0; i < rawImageData.length; i += channelCount) {
        pixels.push(rawImageData[i], rawImageData[i], rawImageData[i], rawImageData[i]); // make monochrome w/ alpha
      }
    }
    let imageData;
    if (isNaN(channelCount) || !rawImageData.some(x => x !== 0)) { // if character is blank
      // console.warn(`no bitmap for character '${char}' (${char.charCodeAt(0)}), adding to font as empty`);
      // console.warn(command);
      // console.warn('---');
      width = 0;
      height = 0;
    } else {
      imageData = new Canvas.ImageData(new Uint8ClampedArray(pixels), width, height);
    }
    const container = {
      data: {
        imageData,
        fontData: {
          id: char.charCodeAt(0),
          index: glyph.index,
          char: char,
          width: width,
          height: height,
          xoffset: Math.round(bBox.x1) - pad,
          yoffset: Math.round(bBox.y1) + pad + baseline,
          xadvance: glyph.advanceWidth * scale,
          chnl: 15
        }
      },
      width: width,
      height: height
    };
    callback(null, container);
  });
}

