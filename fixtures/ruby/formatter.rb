module Formatter
  def self.titleize(str)
    str.split.map(&:capitalize).join(" ")
  end

  def self.truncate(str, length)
    str.length > length ? str[0...length] + "..." : str
  end
end
