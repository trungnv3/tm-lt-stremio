// =========================================================
// TM-LT Stremio - TMDB API
// =========================================================

const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const VI_LANGUAGE = "vi-VN";
const EN_LANGUAGE = "en-US";

// ---------------------------------------------------------
// Gọi TMDB API
// ---------------------------------------------------------
async function tmdbFetch(path, env, params = {}, language = VI_LANGUAGE) {
  if (!env.TMDB_API_KEY) {
    throw new Error("TMDB_API_KEY chưa được khai báo");
  }

  const url = new URL(
    TMDB_BASE_URL + path
  );

  url.searchParams.set(
    "language",
    language
  );

  url.searchParams.set(
    "api_key",
    env.TMDB_API_KEY
  );

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  const response = await fetch(
    url.toString()
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `TMDB HTTP ${response.status}: ${
        data?.status_message || "Unknown error"
      }`
    );
  }

  return data;
}

// ---------------------------------------------------------
// Movie theo ID
// ---------------------------------------------------------
export async function getMovieById(
  tmdbId,
  env,
  language = VI_LANGUAGE
) {
  return tmdbFetch(
    `/movie/${tmdbId}`,
    env,
    {},
    language
  );
}

// ---------------------------------------------------------
// TV theo ID
// ---------------------------------------------------------
export async function getTvById(
  tmdbId,
  env,
  language = VI_LANGUAGE
) {
  return tmdbFetch(
    `/tv/${tmdbId}`,
    env,
    {},
    language
  );
}

// ---------------------------------------------------------
// Search Movie
// ---------------------------------------------------------
export async function searchMovie(
  query,
  env,
  year = null,
  language = VI_LANGUAGE
) {
  const params = {
    query: query
  };

  if (year) {
    params.year = year;
  }

  return tmdbFetch(
    "/search/movie",
    env,
    params,
    language
  );
}

// ---------------------------------------------------------
// Search TV
// ---------------------------------------------------------
export async function searchTv(
  query,
  env,
  year = null,
  language = VI_LANGUAGE
) {
  const params = {
    query: query
  };

  if (year) {
    params.first_air_date_year = year;
  }

  return tmdbFetch(
    "/search/tv",
    env,
    params,
    language
  );
}

// ---------------------------------------------------------
// Chọn Movie tốt nhất
// ---------------------------------------------------------
// ---------------------------------------------------------
// Chọn Movie tốt nhất
// Ưu tiên:
// 1. Title khớp + năm khớp
// 2. Title gần khớp + năm khớp
// 3. Title khớp
// 4. Loại bỏ các nội dung phụ như Making of / Behind the Scenes
// 5. Không chọn chỉ vì cùng năm
// ---------------------------------------------------------
export function pickBestMovieResult(
  data,
  year = null,
  query = ""
) {
  if (
    !data ||
    !Array.isArray(data.results) ||
    data.results.length === 0
  ) {
    return null;
  }

  const normalizeTitle = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const queryNormalized =
    normalizeTitle(query);

  const queryCompact =
    queryNormalized.replace(/\s+/g, "");

  const badContentPatterns = [
    /\bmaking of\b/i,
    /\bbehind the scenes\b/i,
    /\bbehind the scene\b/i,
    /\bfeaturette\b/i,
    /\binterview\b/i,
    /\btrailer\b/i,
    /\bteaser\b/i,
    /\bshort\b/i,
    /\bspecial\b/i,
    /\bdocumentary\b/i,
    /\bdocumentaries\b/i,
    /\bextras\b/i,
    /\bbonus\b/i,
    /\bproduction\b/i,
    /\bbirth story\b/i
  ];

  function isBadContent(item) {
    const title =
      String(item?.title || "");

    const originalTitle =
      String(item?.original_title || "");

    const combined =
      `${title} ${originalTitle}`;

    return badContentPatterns.some(
      (pattern) =>
        pattern.test(combined)
    );
  }

  function getYear(item) {
    if (!item?.release_date) {
      return null;
    }

    const value =
      Number(
        String(item.release_date)
          .slice(0, 4)
      );

    return Number.isFinite(value)
      ? value
      : null;
  }

  function getTitleVariants(item) {
    return [
      normalizeTitle(item?.title),
      normalizeTitle(item?.original_title)
    ].filter(Boolean);
  }

  function similarityScore(a, b) {
    if (!a || !b) {
      return 0;
    }

    if (a === b) {
      return 100;
    }

    if (
      a.includes(b) ||
      b.includes(a)
    ) {
      return 80;
    }

    const aWords = new Set(
      a.split(" ").filter(Boolean)
    );

    const bWords = new Set(
      b.split(" ").filter(Boolean)
    );

    if (
      aWords.size === 0 ||
      bWords.size === 0
    ) {
      return 0;
    }

    let common = 0;

    for (const word of aWords) {
      if (bWords.has(word)) {
        common++;
      }
    }

    const union =
      new Set([
        ...aWords,
        ...bWords
      ]).size;

    return Math.round(
      (common / union) * 70
    );
  }

  // -------------------------------------------------------
  // Chấm điểm từng kết quả
  // -------------------------------------------------------
  const scored = data.results.map(
    (item, index) => {
      const itemYear =
        getYear(item);

      const titleVariants =
        getTitleVariants(item);

      let score = 0;

      // Nội dung phụ → trừ rất mạnh
      if (isBadContent(item)) {
        score -= 1000;
      }

      // ---------------------------------------------------
      // TITLE
      // ---------------------------------------------------
      let bestTitleScore = 0;

      for (
        const itemTitle
        of titleVariants
      ) {
        const compactTitle =
          itemTitle.replace(
            /\s+/g,
            ""
          );

        if (
          itemTitle === queryNormalized
        ) {
          bestTitleScore =
            Math.max(
              bestTitleScore,
              500
            );
        } else if (
          compactTitle ===
          queryCompact
        ) {
          bestTitleScore =
            Math.max(
              bestTitleScore,
              480
            );
        } else {
          bestTitleScore =
            Math.max(
              bestTitleScore,
              similarityScore(
                itemTitle,
                queryNormalized
              )
            );
        }
      }

      score += bestTitleScore;

      // ---------------------------------------------------
      // YEAR
      // ---------------------------------------------------
      if (
        year &&
        itemYear === Number(year)
      ) {
        score += 300;
      } else if (
        year &&
        itemYear
      ) {
        const yearDiff =
          Math.abs(
            itemYear -
            Number(year)
          );

        if (yearDiff === 1) {
          score -= 40;
        } else if (
          yearDiff === 2
        ) {
          score -= 80;
        } else {
          score -= 150;
        }
      }

      // ---------------------------------------------------
      // Có poster → ưu tiên nhẹ
      // ---------------------------------------------------
      if (item.poster_path) {
        score += 10;
      }

      // ---------------------------------------------------
      // Vote/popularity chỉ dùng làm tie-breaker nhẹ
      // Không được phép lấn át title
      // ---------------------------------------------------
      if (
        typeof item.vote_count ===
        "number"
      ) {
        score += Math.min(
          item.vote_count / 1000,
          10
        );
      }

      if (
        typeof item.popularity ===
        "number"
      ) {
        score += Math.min(
          item.popularity / 10,
          5
        );
      }

      return {
        item,
        score,
        index,
        itemYear,
        bestTitleScore,
        badContent:
          isBadContent(item)
      };
    }
  );

  // -------------------------------------------------------
  // Loại nội dung phụ nếu vẫn còn ứng viên chính
  // -------------------------------------------------------
  const normalResults =
    scored.filter(
      (entry) =>
        !entry.badContent
    );

  const candidates =
    normalResults.length > 0
      ? normalResults
      : scored;

  // -------------------------------------------------------
  // Sắp xếp:
  // score cao nhất trước
  // -------------------------------------------------------
  candidates.sort(
    (a, b) => {
      if (
        b.score !== a.score
      ) {
        return b.score - a.score;
      }

      // Nếu bằng điểm → ưu tiên đúng năm
      const aYearMatch =
        year &&
        a.itemYear === Number(year);

      const bYearMatch =
        year &&
        b.itemYear === Number(year);

      if (
        aYearMatch !==
        bYearMatch
      ) {
        return bYearMatch
          ? 1
          : -1;
      }

      // Cuối cùng giữ thứ tự TMDB
      return a.index - b.index;
    }
  );

  return candidates[0]?.item || null;
}

// ---------------------------------------------------------
// Ghép dữ liệu vi-VN + en-US
// Ưu tiên vi-VN, thiếu thì dùng en-US
// ---------------------------------------------------------
function mergeLocalizedData(
  vietnamese,
  english
) {
  const vi =
    vietnamese || {};

  const en =
    english || {};

  const merged = {
    ...en,
    ...vi
  };

  const fallbackFields = [
    "title",
    "original_title",
    "name",
    "original_name",
    "overview",
    "release_date",
    "first_air_date",
    "poster_path",
    "backdrop_path"
  ];

  for (const field of fallbackFields) {
    if (
      vi[field] === null ||
      vi[field] === undefined ||
      vi[field] === ""
    ) {
      merged[field] =
        en[field] ??
        vi[field] ??
        null;
    }
  }

  // Các trường số: nếu vi-VN không có
  // thì giữ giá trị từ en-US
  const numericFields = [
    "id",
    "vote_average",
    "vote_count",
    "popularity",
    "runtime",
    "number_of_seasons",
    "number_of_episodes"
  ];

  for (const field of numericFields) {
    if (
      vi[field] === null ||
      vi[field] === undefined
    ) {
      merged[field] =
        en[field] ??
        null;
    }
  }

  // Genres thường giống nhau giữa hai ngôn ngữ.
  // Ưu tiên vi-VN nếu có dữ liệu.
  if (
    !Array.isArray(vi.genres) ||
    vi.genres.length === 0
  ) {
    merged.genres =
      Array.isArray(en.genres)
        ? en.genres
        : [];
  }

  return merged;
}


// ---------------------------------------------------------
// Chuẩn hóa Movie
// ---------------------------------------------------------
function normalizeMovie(
  vietnamese,
  english
) {
  const data = mergeLocalizedData(
    vietnamese,
    english
  );

  return {
    tmdbId: data.id,
    type: "movie",

    title: data.title,
    originalTitle: data.original_title,

    overview: data.overview || "",

    releaseDate:
      data.release_date || null,

    year:
      data.release_date
        ? Number(
            data.release_date.slice(0, 4)
          )
        : null,

    posterPath:
      data.poster_path || null,

    backdropPath:
      data.backdrop_path || null,

    voteAverage:
      data.vote_average ?? null,

    voteCount:
      data.vote_count ?? null,

    popularity:
      data.popularity ?? null,

    runtime:
      data.runtime ?? null,

    genres:
      Array.isArray(data.genres)
        ? data.genres.map(
            genre => genre.name
          )
        : []
  };
}

// ---------------------------------------------------------
// Chuẩn hóa TV
// ---------------------------------------------------------
function normalizeTv(
  vietnamese,
  english
) {
  const data = mergeLocalizedData(
    vietnamese,
    english
  );

  return {
    tmdbId: data.id,
    type: "tv",

    title: data.name,
    originalTitle: data.original_name,

    overview: data.overview || "",

    firstAirDate:
      data.first_air_date || null,

    year:
      data.first_air_date
        ? Number(
            data.first_air_date.slice(0, 4)
          )
        : null,

    posterPath:
      data.poster_path || null,

    backdropPath:
      data.backdrop_path || null,

    voteAverage:
      data.vote_average ?? null,

    voteCount:
      data.vote_count ?? null,

    popularity:
      data.popularity ?? null,

    numberOfSeasons:
      data.number_of_seasons ?? null,

    numberOfEpisodes:
      data.number_of_episodes ?? null,

    genres:
      Array.isArray(data.genres)
        ? data.genres.map(
            genre => genre.name
          )
        : []
  };
}

// ---------------------------------------------------------
// Resolve Movie theo TMDB ID
//
// Lấy cả vi-VN và en-US.
// Sau đó ghép dữ liệu:
// vi-VN có → dùng vi-VN
// vi-VN trống → dùng en-US
// ---------------------------------------------------------
export async function resolveMovieById(
  tmdbId,
  env
) {
  const vietnamese =
    await getMovieById(
      tmdbId,
      env,
      VI_LANGUAGE
    );

  const english =
    await getMovieById(
      tmdbId,
      env,
      EN_LANGUAGE
    );

  return normalizeMovie(
    vietnamese,
    english
  );
}

// ---------------------------------------------------------
// Resolve TV theo TMDB ID
// ---------------------------------------------------------
export async function resolveTvById(
  tmdbId,
  env
) {
  const vietnamese =
    await getTvById(
      tmdbId,
      env,
      VI_LANGUAGE
    );

  const english =
    await getTvById(
      tmdbId,
      env,
      EN_LANGUAGE
    );

  return normalizeTv(
    vietnamese,
    english
  );
}

// ---------------------------------------------------------
// Resolve Movie theo title + year
// ---------------------------------------------------------
export async function resolveMovieBySearch(
  title,
  year,
  env
) {
  // Tìm kiếm ưu tiên tiếng Việt
  const vietnamese =
    await searchMovie(
      title,
      env,
      year,
      VI_LANGUAGE
    );

  let result =
    pickBestMovieResult(
      vietnamese,
      year,
title
    );

  // Nếu không tìm được bằng tiếng Việt
  // thì thử English
  if (!result) {
    const english =
      await searchMovie(
        title,
        env,
        year,
        EN_LANGUAGE
      );

    result =
      pickBestMovieResult(
        english,
        year,
title
      );
  }

  if (!result) {
    return null;
  }

  // Đã có ID → lấy metadata đầy đủ
  return resolveMovieById(
    result.id,
    env
  );
}

// ---------------------------------------------------------
// Resolve TV theo title + year
// ---------------------------------------------------------
export async function resolveTvBySearch(
  title,
  year,
  env
) {
  const vietnamese =
    await searchTv(
      title,
      env,
      year,
      VI_LANGUAGE
    );

  let result =
    pickBestTvResult(
      vietnamese,
      year
    );

  if (!result) {
    const english =
      await searchTv(
        title,
        env,
        year,
        EN_LANGUAGE
      );

    result =
      pickBestTvResult(
        english,
        year
      );
  }

  if (!result) {
    return null;
  }

  return resolveTvById(
    result.id,
    env
  );
}

// ---------------------------------------------------------
// Resolve Movie hoàn chỉnh
// ---------------------------------------------------------
export async function resolveMovie(
  options,
  env
) {
  const {
    tmdbId,
    title,
    year
  } = options;

  // Có TMDB ID → dùng ID trực tiếp
  if (tmdbId) {
    return resolveMovieById(
      tmdbId,
      env
    );
  }

  // Không có title
  if (!title) {
    return null;
  }

  return resolveMovieBySearch(
    title,
    year,
    env
  );
}

// ---------------------------------------------------------
// Resolve TV hoàn chỉnh
// ---------------------------------------------------------
export async function resolveTv(
  options,
  env
) {
  const {
    tmdbId,
    title,
    year
  } = options;

  // Có TMDB ID → dùng ID trực tiếp
  if (tmdbId) {
    return resolveTvById(
      tmdbId,
      env
    );
  }

  if (!title) {
    return null;
  }

  return resolveTvBySearch(
    title,
    year,
    env
  );
}

// ---------------------------------------------------------
// Resolve theo parser result
// ---------------------------------------------------------
export async function resolveMedia(
  parsed,
  env
) {
  if (!parsed) {
    return null;
  }

  if (parsed.tmdbType === "movie") {
    return resolveMovie(
      parsed,
      env
    );
  }

  if (parsed.tmdbType === "tv") {
    return resolveTv(
      parsed,
      env
    );
  }

  // Mặc định coi file là Movie
  return resolveMovie(
    parsed,
    env
  );
}

// ---------------------------------------------------------
// Poster URL
// ---------------------------------------------------------
export function getPosterUrl(
  posterPath,
  size = "w500"
) {
  if (!posterPath) {
    return null;
  }

  return (
    "https://image.tmdb.org/t/p/" +
    size +
    posterPath
  );
}

// ---------------------------------------------------------
// Backdrop URL
// ---------------------------------------------------------
export function getBackdropUrl(
  backdropPath,
  size = "w1280"
) {
  if (!backdropPath) {
    return null;
  }

  return (
    "https://image.tmdb.org/t/p/" +
    size +
    backdropPath
  );
}