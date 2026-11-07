cask "litedb" do
  arch arm: "aarch64", intel: "x64"

  version "VERSION"
  sha256 arm: "SHA256_ARM", intel: "SHA256_INTEL"

  url "https://github.com/createdbyadham/LiteDB/releases/download/v#{version}/LiteDB_#{version}_#{arch}.dmg"
  name "LiteDB"
  desc "SQLite and PostgreSQL desktop client"
  homepage "https://github.com/createdbyadham/LiteDB"

  livecheck do
    url "https://github.com/createdbyadham/LiteDB/releases/latest"
    regex(%r{/tag/(?:app-)?v?(\d+(?:\.\d+)+)}i)
  end

  auto_updates true
  depends_on macos: ">= :catalina"

  app "LiteDB.app"

  zap trash: [
    "~/Library/Application Support/com.adhamehab.litedb",
    "~/Library/Caches/com.adhamehab.litedb",
    "~/Library/Logs/LiteDB",
    "~/Library/Preferences/com.adhamehab.litedb.plist",
    "~/Library/Saved Application State/com.adhamehab.litedb.savedState",
  ]
end
