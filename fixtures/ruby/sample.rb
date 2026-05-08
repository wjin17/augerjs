class Greeter
  def greet(name)
    "Hello, #{format_name(name)}"
  end

  def format_name(name)
    name.strip
  end
end
