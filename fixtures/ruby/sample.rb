# A utility module.
module Formatter
  def self.titleize(str)
    str.split.map(&:capitalize).join(" ")
  end
end

class Person
  attr_accessor :name, :age
  attr_reader :id

  # Creates a new person.
  def initialize(id, name, age)
    @id = id
    @name = name
    @age = age
  end

  # Returns a greeting.
  def greet
    "Hello, #{Formatter.titleize(@name)}"
  end

  def self.create(name, age)
    new(SecureRandom.uuid, name, age)
  end

  private

  def format_name
    @name.strip
  end
end
