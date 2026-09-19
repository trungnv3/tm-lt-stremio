// src/parser.js

const VIDEO_EXTENSIONS =
  /\.(mkv|mp4|avi|mov|m4v|webm|ts)$/i;

// Những chuỗi chắc chắn không phải tên phim
const TECH_PATTERNS = [
  /\b2160p\b/gi,
  /\b1080p\b/gi,
  /\b720p\b/gi,
  /\b576p\b/gi,
  /\b480p\b/gi,

  /\b4K\b/gi,
  /\bUHD\b/gi,
  /\bFHD\b/gi,
  /\bHD\b/gi,

  /\bWEB[- ]?DL\b/gi,
  /\bWEB[- ]?Rip\b/gi,
  /\bWEB\b/gi,
  /\bBlu[- ]?Ray\b/gi,
  /\bBRRip\b/gi,
  /\bBDRip\b/gi,
  /\bHDRip\b/gi,
  /\bHDTV\b/gi,
  /\bDVDRip\b/gi,
  /\bREMUX\b/gi,

  /\bHEVC\b/gi,
  /\bH\.?265\b/gi,
  /\bx265\b/gi,
  /\bAVC\b/gi,
  /\bH\.?264\b/gi,
  /\bx264\b/gi,

  /\b10bit\b/gi,
  /\b8bit\b/gi,

  /\bDDP?\s*5\.1(?:\.\d+)?\b/gi,
  /\bDD\s*5\.1(?:\.\d+)?\b/gi,
  /\bDTS\b/gi,
  /\bAAC\b/gi,
  /\bAC3\b/gi,
  /\bAtmos\b/gi,

  /\bNF\b/gi,
  /\bAMZN\b/gi,
  /\bNetflix\b/gi,
  /\bAmazon\b/gi,

  /\bViE\b/gi,
  /\bVieDub\b/gi,
  /\bVietDub\b/gi,
  /\bVietnamese\b/gi,
  /\bDUB\b/gi,
  /\bDub\b/gi,
  /\bLT\b/gi,
  /\bLồng tiếng\b/gi,
  /\bThuyet\.?\s*Minh\b/gi,
  /\bThuyết\.?\s*Minh\b/gi,

  /\bFRDS\b/gi,
  /\bEPiKall\b/gi,

  /\bPROPER\b/gi,
  /\bREMASTERED\b/gi,
  /\bLIMITED\b/gi,
  /\bEXTENDED\b/gi,
  /\bUNCUT\b/gi
];

const SOURCE_PATTERNS = [
  /@\w+/gi,
  /\bhdvnbits\.org\b/gi,
  /\bhdvnbits\b/gi,
  /\bDalekW\b/gi,
  /\bEPiKall\b/gi,
  /\bFRDS\b/gi
];

function removeExtension(value) {
  return String(value || "").replace(VIDEO_EXTENSIONS, "");
}

function extractManualTmdbId(filename) {
  const match = String(filename || "").match(
    /\[\s*tmdb-(movie|tv)-(\d+)\s*\]/i
  );

  if (!match) {
    return {
      tmdbId: null,
      tmdbType: null
    };
  }

  return {
    tmdbId: Number(match[2]),
    tmdbType: match[1].toLowerCase()
  };
}

function removeManualTmdbTag(text) {
  return String(text || "").replace(
    /\[\s*tmdb-(movie|tv)-(\d+)\s*\]/gi,
    " "
  );
}

function removeImdb(text) {
  return String(text || "").replace(/\btt\d{5,10}\b/gi, " ");
}

function extractYear(text) {
  const matches = String(text || "").match(
    /\b(19\d{2}|20\d{2})\b/g
  );

  if (!matches) {
    return null;
  }

  return Number(matches[0]);
}

/**
 * Xác định title trước khi bắt đầu phần release/technical.
 *
 * Ví dụ:
 *
 * Bigfoot.Family.2020.VieDub...
 * -> Bigfoot Family
 *
 * Bolt.2008.mHD.x264...
 * -> Bolt
 *
 * Captain.Underpants.The.First.Epic.Movie.2017...
 * -> Captain Underpants The First Epic Movie
 */
function cutAtTechnicalSection(text) {
  let value = String(text || "");

  value = removeExtension(value);
  value = removeImdb(text);
  value = removeManualTmdbTag(value);

  // Đổi dấu chấm thành khoảng trắng
  value = value.replace(/\./g, " ");

  // Chuẩn hóa khoảng trắng
  value = value.replace(/\s+/g, " ").trim();

  const yearMatch = value.match(/\b(19\d{2}|20\d{2})\b/);

  if (!yearMatch) {
    return value;
  }

  const yearIndex = yearMatch.index;
  const beforeYear = value.slice(0, yearIndex).trim();
  const afterYear = value
    .slice(yearIndex + yearMatch[0].length)
    .trim();

  // ---------------------------------------------
  // Trường hợp:
  // 2006 Doraemon Nobita Dinosaur Bluray...
  //
  // Năm đứng đầu -> title nằm phía sau năm.
  // ---------------------------------------------
  if (!beforeYear) {
    let title = afterYear;

    // Cắt tại release tag đầu tiên
    const releaseMatch = title.match(
      /\b(VIE|VIEdub|ViE|DUB|Dub|LT|BluRay|WEB-DL|WEBRip|WEB|1080p|720p|2160p|UHD|AVC|HEVC|x264|x265|H\.264|H\.265|DD|DTS|AAC|AC3)\b/i
    );

    if (releaseMatch) {
      title = title.slice(0, releaseMatch.index);
    }

    return title.trim();
  }

  // ---------------------------------------------
  // Trường hợp title nằm trước năm:
  //
  // Ainbo Spirit of the Amazon 2021 ViE...
  // Bigfoot Family 2020...
  // ---------------------------------------------
  return beforeYear;
}

function removeTechnical(text) {
  let value = String(text || "");

  for (const pattern of TECH_PATTERNS) {
    value = value.replace(pattern, " ");
  }

  for (const pattern of SOURCE_PATTERNS) {
    value = value.replace(pattern, " ");
  }

  return value;
}

/**
 * Xử lý phần dịch tiếng Việt.
 *
 * Các dạng:
 *
 * Home-Hành Trình Trở Về
 * The Good Dinosaur-Chú khủng long tốt bụng
 *
 * -> lấy phần bên trái.
 *
 * Trường hợp:
 *
 * Xứ sở các nguyên tố - Elemental
 *
 * -> lấy Elemental.
 */
function chooseTitlePart(text) {
  let value = String(text || "").trim();

  if (!value) {
    return "";
  }

  value = value.replace(/[–—]/g, "-");

  // ---------------------------------------------
  // English - Vietnamese
  // Ví dụ:
  // Home - Hành Trình Trở Về
  // The Good Dinosaur - Chú khủng long tốt bụng
  // ---------------------------------------------
  const parts = value.split(/\s+-\s+/);

  if (parts.length > 1) {
    const candidates = parts.map((x) => x.trim());

    // Ưu tiên phần không chứa ký tự tiếng Việt
    const englishCandidate = candidates.find(
      (candidate) =>
        candidate &&
        !/[ăâđêôơưáàảãạấầẩẫậắằẳẵặ]/i.test(candidate)
    );

    if (englishCandidate) {
      return englishCandidate;
    }

    return candidates[0];
  }

  // ---------------------------------------------
  // English-Vietnamese
  // ---------------------------------------------
  if (value.includes("-")) {
    const hyphenParts = value
      .split("-")
      .map((x) => x.trim())
      .filter(Boolean);

    if (hyphenParts.length > 1) {
      const englishCandidate = hyphenParts.find(
        (candidate) =>
          !/[ăâđêôơưáàảãạấầẩẫậắằẳẵặ]/i.test(candidate)
      );

      if (englishCandidate) {
        return englishCandidate;
      }

      return hyphenParts[0];
    }
  }

  return value;
}

/**
 * Nhận diện một chuỗi có khả năng là title tiếng Anh.
 *
 * Không cần hoàn hảo; mục tiêu là phân biệt
 * English title với phần dịch tiếng Việt.
 */
function containsEnglishWords(text) {
  const value = String(text || "");

  // Có ký tự tiếng Việt -> chưa chắc là tiếng Việt,
  // nhưng nếu có nhiều ký tự đặc trưng thì ưu tiên không phải English.
  if (/[ăâđêôơưáàảãạấầẩẫậắằẳẵặ]/i.test(value)) {
    return false;
  }

  // Có chữ Latin cơ bản
  return /[A-Za-z]/.test(value);
}

function cleanTitle(text) {
  let value = String(text || "");

  // Loại technical tags
  value = removeTechnical(value);

  // Các source / release còn sót
  value = value.replace(
    /\bhdvnbits(?:\.org)?\b/gi,
    " "
  );

  value = value.replace(
    /\b(DalekW|EPiKall|FRDS)\b/gi,
    " "
  );

  // Loại số release kiểu -001
  value = value.replace(
    /[-_ ]\d{3,4}\b/g,
    " "
  );

  // Xóa ngoặc
  value = value.replace(/[()[\]{}]/g, " ");

  // Xóa ký tự phân cách
  value = value.replace(/[_|]+/g, " ");

  // Chuẩn hóa khoảng trắng
  value = value.replace(/\s+/g, " ").trim();

  // Dấu câu đầu/cuối
  value = value
    .replace(/^[\s\-,:;]+/, "")
    .replace(/[\s\-,:;]+$/, "")
    .trim();

  return value;
}

function buildQueries(title, year) {
  if (!title) {
    return [];
  }

  const queries = [];

  if (year) {
    queries.push(`${title} ${year}`);
  }

  queries.push(title);

  return [...new Set(queries)];
}

export function parseFilename(filename) {
  const originalFilename = String(filename || "");

  const manual = extractManualTmdbId(originalFilename);

  const year = extractYear(originalFilename);

  let title = cutAtTechnicalSection(originalFilename);

  title = chooseTitlePart(title);

  title = cleanTitle(title);

  const queries = manual.tmdbId
    ? []
    : buildQueries(title, year);

  return {
    filename: originalFilename,
    title,
    year,
    tmdbId: manual.tmdbId,
    tmdbType: manual.tmdbType,
    queries
  };
}

export const parseMovieFilename = parseFilename;

export function testParser(filenames = []) {
  const testFiles = filenames.length
    ? filenames
    : [
        "Ainbo.Spirit.of.the.Amazon.2021.ViE.Dub.1080p.WEB-DL.DD5.1.x264.mkv",

        "Big.Hero.6.(2014) LT-001.mkv",

        "Bigfoot.Family.2020.VieDub.1080p.WEB-DL.DD5.1 - Gia Đình Chân to-001.mkv",

        "Bolt.2008.mHD.x264-Thuyet.Minh-EPiKall.hdvnbits.org(1).mkv",

        "Captain.Underpants.The.First.Epic.Movie.2017.ViE.1080p.BluRay.HEVC.10bit-DalekW@FRDS-001.mkv",

        "2006.Doraemon.Nobita.Dinosaur.Bluray.VIE.1080p.AVC.DD.5.1.mkv",

        "Duck.Duck.Goose.2018.ViE.DUB.1080p.BluRay. - Ngỗng Vịt Phiêu Lưu Ký-001.mkv",

        "Home-Hành Trình Trở Về (2015) LT.mkv",

        "Xứ sở các nguyên tố (2023) LT - Elemental-001.mkv",

        "The Good Dinosaur.2015-Chú khủng long tốt bụng (2015) LT.mkv",

        "tt0102587.Only.Yesterday.1991.1080p.mkv",

        "Puss.in.Boots.The.Last.Wish.[tmdb-movie-315162].mkv"
      ];

  return testFiles.map((filename) =>
    parseFilename(filename)
  );
}

export default {
  parseFilename,
  parseMovieFilename,
  testParser
};